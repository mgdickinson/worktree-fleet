#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureStateRoot } from "../core/init.js";
import { stateRoot } from "../core/paths.js";
import { ensureIntent, ensureSession, findSessionForWorktree, isSessionLockTimeoutError, listIntents, listSessions, markSessionEnded, readSession, refreshSessionDirty, sweepStaleSessions, updateIntent, writeSession } from "../core/session.js";
import { syncSession } from "../core/integration.js";
import { listAdapters, readAdapter, registerAdapter, unregisterAdapter } from "../core/adapters.js";
import { listActivity, logActivity } from "../core/activity.js";
import { listMainEvents, pruneMainEvents } from "../core/events.js";
import { installHooks, managedHooksInstalled, uninstallHooks } from "../hooks/install.js";
import { logHookFailure, mainAdvanced } from "../hooks/main-advanced.js";
import { getRepoInfo } from "../git/repo.js";
import { git } from "../git/command.js";
import { startSidecar } from "../sidecar/run.js";
import { ensureRepoConfig } from "../core/repo-config.js";
import { readJsonFile } from "../core/fs.js";
import { lastFetchPath } from "../core/paths.js";
import type { IntentState, SessionState } from "../core/types.js";

const FLEET_WORKTREE_CHECK_TTL_MS = 10 * 60 * 1000;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        printHelp();
        return 0;
      case "setup":
        return setup(rest);
      case "init":
        return init(rest);
      case "doctor":
        return doctor();
      case "status":
        return status(rest);
      case "watch":
        return watch(rest);
      case "activity":
        return activity(rest);
      case "sync":
        return sync();
      case "session":
        return session(rest);
      case "sidecar":
        return sidecar(rest);
      case "hook":
        return hook(rest);
      case "claude-hook":
        return claudeHook();
      case "intent":
      case "intents":
        return intent(rest);
      case "adapter":
        return adapter(rest);
      case "plugin":
        return plugin(rest);
      case "gc":
        return gc(rest);
      case "migrate":
        ensureStateRoot();
        console.log("state schema is current");
        return 0;
      case "uninstall":
        return uninstall();
      default:
        console.error(`unknown command: ${command}`);
        printHelp();
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printHelp(): void {
  console.log(`worktree-fleet

Usage:
  worktree-fleet setup [--yes] [--no-adapters|--adapter <kind>|--all-adapters]
  worktree-fleet init
  worktree-fleet status [--refresh-current]
  worktree-fleet watch [--interval <seconds>] [--once] [--no-refresh-current]
  worktree-fleet activity [--limit <n>] [--all] [--json]
  worktree-fleet sync
  worktree-fleet gc [--days <n>]
  worktree-fleet claude-hook
  worktree-fleet intent declare <path...>
  worktree-fleet intent release <path...>
  worktree-fleet session start --agent <kind> -- <command...>
  worktree-fleet adapter install|uninstall|list [kind]
  worktree-fleet plugin path codex
  worktree-fleet doctor
  fleet codex [-- <codex args...>]`);
}

function setup(args: string[]): number {
  ensureStateRoot();
  const repoConfig = ensureRepoConfig(process.cwd());
  const changed = installHooks(process.cwd());
  enableRerere();
  const repo = getRepoInfo(process.cwd());
  logActivity({
    kind: "repo-setup",
    summary: `setup fleet for ${repoConfig.integration_branch}`,
    repoId: repo.repoId,
    sessionId: null,
    worktreePath: repo.root,
    details: {
      integration_branch: repoConfig.integration_branch,
      hooks_changed: changed,
      args
    }
  });
  const adapters = parseAdapterFlags(args);
  console.log("worktree-fleet ready");
  console.log(`state     ${stateRoot()}`);
  console.log(`hooks     ${changed.length ? `installed/updated (${changed.length})` : "already installed"}`);
  console.log(`branch    ${repoConfig.integration_branch}`);
  if (adapters.noAdapters) {
    console.log("adapters  skipped");
  } else if (adapters.allAdapters || adapters.adapters.length > 0) {
    for (const adapterName of adapters.allAdapters ? ["codex", "claude"] : adapters.adapters) {
      installAdapter(adapterName);
    }
  } else {
    console.log("adapters  not installed; rerun with --adapter codex or --all-adapters");
  }
  console.log("run `worktree-fleet status` any time");
  return 0;
}

function init(_args: string[]): number {
  ensureStateRoot();
  const repoConfig = ensureRepoConfig(process.cwd());
  const changed = installHooks(process.cwd());
  enableRerere();
  const repo = getRepoInfo(process.cwd());
  logActivity({
    kind: "repo-initialized",
    summary: `initialized fleet for ${repoConfig.integration_branch}`,
    repoId: repo.repoId,
    sessionId: null,
    worktreePath: repo.root,
    details: {
      integration_branch: repoConfig.integration_branch,
      hooks_changed: changed
    }
  });
  console.log(`state root: ${stateRoot()}`);
  console.log(`integration branch: ${repoConfig.integration_branch}`);
  console.log(changed.length ? `hooks installed: ${changed.join(", ")}` : "hooks already installed");
  return 0;
}

function uninstall(): number {
  const changed = uninstallHooks(process.cwd());
  const repo = safe(() => getRepoInfo(process.cwd()));
  logActivity({
    kind: "repo-uninstalled",
    summary: "removed fleet hook blocks",
    repoId: repo?.repoId ?? null,
    sessionId: null,
    worktreePath: repo?.root ?? process.cwd(),
    details: {
      hooks_changed: changed
    }
  });
  console.log(changed.length ? `removed fleet hook blocks from ${changed.length} hooks` : "no fleet hook blocks found");
  return 0;
}

function doctor(): number {
  ensureStateRoot();
  const checks: Array<[string, boolean, string]> = [];
  const repo = safe(() => getRepoInfo(process.cwd()));
  const adapters = safe(() => listAdapters()) ?? [];
  checks.push(["git repo detected", Boolean(repo), repo ? repo.root : "not in a git repo"]);
  checks.push(["state root writable", safe(() => { ensureStateRoot(); return true; }) === true, stateRoot()]);
  if (repo) {
    checks.push(["managed hooks installed", safe(() => managedHooksInstalled(process.cwd())) === true, repo.commonDir]);
    checks.push(["rerere enabled", safe(() => git(process.cwd(), ["config", "--bool", "rerere.enabled"]).stdout) === "true", "git config rerere.enabled"]);
    checks.push(["fetch metadata writable", safe(() => { ensureRepoConfig(process.cwd()); return Boolean(readJsonFile(lastFetchPath(repo.repoId)) ?? true); }) === true, lastFetchPath(repo.repoId)]);
  }
  checks.push(["active sessions readable", safe(() => listSessions().length >= 0) === true, `${listSessions().length} sessions`]);
  checks.push(["dirty snapshots visible", listSessions().every((session) => Boolean(session.dirty_refreshed_at)), "published by sessions"]);
  checks.push(["adapter registrations readable", Boolean(adapters), `${adapters.length} adapters`]);

  let failed = false;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

function status(args: string[]): number {
  ensureStateRoot();
  sweepStaleSessions();
  if (args.includes("--refresh-current")) {
    const current = ensureSession(process.cwd());
    refreshSessionDirty(current);
  }

  const intents = new Map(listIntents().map((intentState) => [intentState.session_id, intentState]));
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("no active fleet sessions");
    return 0;
  }

  for (const session of sessions) {
    const intentState = intents.get(session.session_id);
    const adapterInfo = readAdapter(session.agent_kind) ?? readAdapter(session.agent_kind.replace("-code", "")) ?? null;
    const adapterLabel = adapterInfo ? `${session.agent_kind}/${adapterInfo.mode}` : session.agent_kind;
    const pending = session.integration.pending?.sha.slice(0, 12) ?? "-";
    const divergent = session.integration.divergent_targets.map((target) => target.sha.slice(0, 12)).join(",") || "-";
    const blocked = session.integration.blocked ? (session.integration.blocked_reason ?? "blocked") : "-";
    const dirty = session.dirty_files.length ? session.dirty_files.join(",") : "-";
    const upcoming = intentState?.upcoming.length ? intentState.upcoming.join(",") : "-";
    console.log(`${session.session_id.slice(0, 8)}  ${adapterLabel}  ${session.branch}  ${session.worktree_path}`);
    console.log(`  pending=${pending} divergent=${divergent} blocked=${blocked}`);
    console.log(`  dirty=${dirty}`);
    console.log(`  upcoming=${upcoming}`);
  }
  const adapters = listAdapters();
  if (adapters.length > 0) {
    console.log("adapters:");
    for (const adapterRegistration of adapters) {
      console.log(`  ${adapterRegistration.kind} mode=${adapterRegistration.mode} native_lifecycle=${adapterRegistration.native_lifecycle ? "yes" : "no"}`);
    }
  }
  return 0;
}

function activity(args: string[]): number {
  ensureStateRoot();
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 && args[limitIndex + 1] ? Number(args[limitIndex + 1]) : 30;
  const json = args.includes("--json");
  const all = args.includes("--all");
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("usage: worktree-fleet activity [--limit <positive-number>] [--all] [--json]");
    return 2;
  }

  const repo = !all ? safe(() => getRepoInfo(process.cwd())) : null;
  const events = listActivity({ repoId: repo?.repoId ?? null, limit });
  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return 0;
  }

  console.log(`worktree-fleet activity (${events.length} events${repo ? `, current repo` : ""})`);
  if (events.length === 0) {
    console.log("  no activity recorded yet");
    return 0;
  }
  for (const event of events) {
    const session = event.session_id ? event.session_id.slice(0, 8) : "-";
    console.log(`${event.created_at}  ${pad(event.kind, 16)} ${pad(session, 8)} ${event.summary}`);
  }
  return 0;
}

async function watch(args: string[]): Promise<number> {
  ensureStateRoot();
  const once = args.includes("--once");
  const noRefreshCurrent = args.includes("--no-refresh-current");
  const intervalIndex = args.indexOf("--interval");
  const intervalSeconds = intervalIndex >= 0 && args[intervalIndex + 1] ? Number(args[intervalIndex + 1]) : 2;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    console.error("usage: worktree-fleet watch [--interval <positive-seconds>] [--once] [--no-refresh-current]");
    return 2;
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const frame = renderWatchFrame({ refreshCurrent: !noRefreshCurrent });
    if (!once && process.stdout.isTTY) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    process.stdout.write(frame);
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  } while (!stopped);

  if (!once && process.stdout.isTTY) process.stdout.write("\n");
  return 0;
}

function sync(): number {
  ensureStateRoot();
  sweepStaleSessions();
  const session = ensureSession(process.cwd());
  const result = syncSession(session);
  console.log(result.message);
  return result.status === "error" ? 1 : 0;
}

async function session(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "start") {
    console.error("usage: worktree-fleet session start --agent <kind> -- <command...>");
    return 2;
  }

  const separator = rest.indexOf("--");
  const command = separator >= 0 ? rest.slice(separator + 1) : [];
  const before = separator >= 0 ? rest.slice(0, separator) : rest;
  const agentIndex = before.indexOf("--agent");
  const agent = agentIndex >= 0 ? before[agentIndex + 1] : "generic-cli";
  if (command.length === 0) {
    console.error("missing wrapped command");
    return 2;
  }

  ensureStateRoot();
  sweepStaleSessions();
  const fleetSession = ensureSession(process.cwd(), agent);
  const sidecar = startSidecar(fleetSession);
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      WORKTREE_FLEET_SESSION_ID: fleetSession.session_id
    }
  });

  const code = await new Promise<number>((resolve) => {
    child.on("exit", (status, signal) => {
      if (signal) resolve(128);
      else resolve(status ?? 0);
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
  });
  sidecar.stop();
  await sidecar.done;
  markSessionEnded(fleetSession);
  return code;
}

async function sidecar(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "run") {
    console.error("usage: worktree-fleet sidecar run --agent <kind>");
    return 2;
  }

  const agentIndex = rest.indexOf("--agent");
  const agent = agentIndex >= 0 ? rest[agentIndex + 1] : "generic-cli";
  ensureStateRoot();
  sweepStaleSessions();
  const fleetSession = agent === "claude-code"
    ? bootstrapClaudeSession(process.cwd())
    : ensureSession(process.cwd(), agent);
  const controller = startSidecar(fleetSession);
  const stop = () => controller.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await controller.done;
  return 0;
}

function hook(args: string[]): number {
  const [subcommand, cwd = process.cwd(), statusCode = ""] = args;
  if (subcommand === "main-advanced") {
    mainAdvanced(cwd);
    return 0;
  }
  if (subcommand === "log-failure") {
    const [kind = "unknown", failureCwd = cwd, status = statusCode] = args.slice(1);
    console.error(`logged hook failure: ${logHookFailure(kind, failureCwd, status)}`);
    return 0;
  }
  console.error("usage: worktree-fleet hook main-advanced <cwd>");
  return 2;
}

function claudeHook(): number {
  try {
    return claudeHookUnsafe();
  } catch (error) {
    if (isSessionLockTimeoutError(error)) return 0;
    throw error;
  }
}

function claudeHookUnsafe(): number {
  const input = readHookInput();
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "unknown";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!safe(() => getRepoInfo(cwd))) return 0;

  if (event === "SessionStart") {
    const session = bootstrapClaudeSession(cwd);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: claudeSessionContext(session.branch)
      }
    }));
    return 0;
  }

  if (event === "UserPromptSubmit") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (shouldInjectFleetWorktreePromptContext(prompt)) {
      const branch = safe(() => ensureRepoConfig(cwd).integration_branch) ?? "main";
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: claudeWorktreePromptContext(branch)
        }
      }));
    }
    return 0;
  }

  if (event === "PreToolUse") {
    const session = ensureClaudeSession(cwd);
    const command = bashCommand(input);
    if (command && isFleetWorktreeCheck(command)) {
      updateIntent(session.session_id, (intentState) => ({
        ...intentState,
        last_fleet_check_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));
    }

    const manualGitCatchup = manualGitCatchupBlock(input, cwd);
    if (manualGitCatchup) {
      console.error(manualGitCatchup);
      return 2;
    }

    const manualWorktreeLifecycle = manualGitWorktreeLifecycleBlock(input, session);
    if (manualWorktreeLifecycle) {
      console.error(manualWorktreeLifecycle);
      return 2;
    }

    const touched = extractToolPaths(input, cwd);
    if (touched.length > 0) {
      updateIntent(session.session_id, (intentState) => ({
        ...intentState,
        tool_touched: Array.from(new Set([...intentState.tool_touched, ...touched])).sort(),
        updated_at: new Date().toISOString()
      }));
    }
    return 0;
  }

  if (event === "PostToolUse") {
    refreshSessionDirty(ensureClaudeSession(cwd));
    return 0;
  }

  if (event === "Stop") {
    if (input.stop_hook_active === true) return 0;
    const session = bootstrapClaudeSession(cwd);
    const result = syncSession(session);
    if (result.status === "blocked" || result.status === "error") {
      const latest = readSession(session.session_id) ?? result.session;
      const key = blockKey(latest);
      if (key && latest.integration.last_notified_block_key !== key) {
        const next = structuredClone(latest);
        next.integration.last_notified_block_key = key;
        writeSession(next);
        console.error(formatClaudeBlockMessage(next));
        return 2;
      }
    }
    return 0;
  }

  if (event === "SessionEnd") {
    const session = findSessionForWorktree(cwd);
    if (session?.agent_kind === "claude-code") markSessionEnded(session);
    return 0;
  }

  return 0;
}

function intent(args: string[]): number {
  const [subcommand, ...paths] = args;
  const session = ensureSession(process.cwd());
  if (subcommand === "declare") {
    updateIntent(session.session_id, (intentState) => ({
      ...intentState,
      upcoming: Array.from(new Set([...intentState.upcoming, ...paths])).sort(),
      updated_at: new Date().toISOString()
    }));
    logActivity({
      kind: "intent-declared",
      summary: `declared intent for ${paths.length} paths`,
      repoId: session.repo_id,
      sessionId: session.session_id,
      worktreePath: session.worktree_path,
      details: {
        paths
      }
    });
    console.log(`declared ${paths.length} paths`);
    return 0;
  }
  if (subcommand === "release") {
    updateIntent(session.session_id, (intentState) => ({
      ...intentState,
      upcoming: intentState.upcoming.filter((entry) => !paths.includes(entry)),
      updated_at: new Date().toISOString()
    }));
    logActivity({
      kind: "intent-released",
      summary: `released intent for ${paths.length} paths`,
      repoId: session.repo_id,
      sessionId: session.session_id,
      worktreePath: session.worktree_path,
      details: {
        paths
      }
    });
    console.log(`released ${paths.length} paths`);
    return 0;
  }
  console.error("usage: worktree-fleet intent declare|release <path...>");
  return 2;
}

function adapter(args: string[]): number {
  const [subcommand, kind] = args;
  if (subcommand === "install" && kind) {
    installAdapter(kind);
    return 0;
  }
  if (subcommand === "uninstall" && kind) {
    const removed = unregisterAdapter(kind);
    console.log(removed ? `${kind} adapter registration removed` : `${kind} adapter was not registered`);
    return 0;
  }
  if (subcommand === "list") {
    const adapters = listAdapters();
    if (adapters.length === 0) {
      console.log("no adapters registered");
      return 0;
    }
    for (const adapterRegistration of adapters) {
      console.log(`${adapterRegistration.kind}  mode=${adapterRegistration.mode} command=${adapterRegistration.command ?? "-"}`);
    }
    return 0;
  }
  console.error("usage: worktree-fleet adapter install|uninstall <kind> | adapter list");
  return 2;
}

function plugin(args: string[]): number {
  const [subcommand, kind = "codex"] = args;
  if (subcommand === "path" && kind === "codex") {
    console.log(path.join(packageRoot(), "plugins", "worktree-fleet-codex"));
    return 0;
  }
  console.error("usage: worktree-fleet plugin path codex");
  return 2;
}

function gc(args: string[]): number {
  ensureStateRoot();
  const daysIndex = args.indexOf("--days");
  const days = daysIndex >= 0 && args[daysIndex + 1] ? Number(args[daysIndex + 1]) : 30;
  if (!Number.isFinite(days) || days < 1) {
    console.error("usage: worktree-fleet gc [--days <positive-number>]");
    return 2;
  }
  const removed = pruneMainEvents(days);
  console.log(`removed ${removed} main-event files older than ${days} days`);
  return 0;
}

interface WatchRenderOptions {
  refreshCurrent: boolean;
}

interface WatchSession {
  session: SessionState;
  intent: IntentState | null;
  adapterMode: string;
  writeSet: string[];
  contended: string[];
}

function renderWatchFrame(options: WatchRenderOptions): string {
  ensureStateRoot();
  sweepStaleSessions();
  const repo = safe(() => getRepoInfo(process.cwd()));
  if (repo && options.refreshCurrent) {
    refreshSessionDirty(ensureSession(repo.root));
  }

  const repoConfig = repo ? safe(() => ensureRepoConfig(repo.root)) : null;
  const hooksOk = repo ? safe(() => managedHooksInstalled(repo.root)) === true : false;
  const intents = new Map(listIntents().map((intentState) => [intentState.session_id, intentState]));
  const allSessions = listSessions();
  const sessions = repo ? allSessions.filter((session) => session.repo_id === repo.repoId) : allSessions;
  const watchSessions = buildWatchSessions(sessions, intents);
  const events = repo ? listMainEvents(repo.repoId).slice(-6).reverse() : [];
  const adapters = listAdapters();
  const now = new Date();
  const health = fleetHealth(watchSessions);
  const lines: string[] = [];

  lines.push(`${bold("worktree-fleet watch")}  ${dim(now.toLocaleString())}`);
  lines.push(`repo       ${repo?.root ?? "not in a git repo"}`);
  lines.push(`state      ${stateRoot()}`);
  if (repo && repoConfig) {
    lines.push(`branch     ${repo.branch}  integration=${repoConfig.integration_branch}  remote=${repoConfig.integration_remote_ref}  hooks=${hooksOk ? green("ok") : yellow("missing")}`);
  }
  lines.push(`health     ${formatHealth(health)}  sessions=${watchSessions.length}  events=${events.length}  adapters=${adapters.length}`);
  lines.push("");
  lines.push(bold("Next Action"));
  lines.push(`  ${nextAction(watchSessions)}`);
  lines.push("");
  lines.push(bold("Sessions"));
  if (watchSessions.length === 0) {
    lines.push("  no active fleet sessions");
  } else {
    lines.push(`  ${pad("id", 8)} ${pad("agent/mode", 22)} ${pad("branch", 16)} ${pad("state", 10)} ${pad("dirty", 5)} ${pad("intent", 6)} ${pad("pending", 12)} ${pad("blocked", 22)} worktree`);
    for (const entry of watchSessions) {
      const session = entry.session;
      const state = sessionStateLabel(session);
      const pending = session.integration.pending?.sha.slice(0, 12) ?? "-";
      const blocked = session.integration.blocked ? (session.integration.blocked_reason ?? "blocked") : "-";
      const intentCount = (entry.intent?.tool_touched.length ?? 0) + (entry.intent?.upcoming.length ?? 0);
      lines.push(`  ${pad(session.session_id.slice(0, 8), 8)} ${pad(`${session.agent_kind}/${entry.adapterMode}`, 22)} ${pad(session.branch, 16)} ${pad(state, 10)} ${pad(String(session.dirty_files.length), 5)} ${pad(String(intentCount), 6)} ${pad(pending, 12)} ${pad(blocked, 22)} ${session.worktree_path}`);
    }
  }
  lines.push("");
  lines.push(bold("Details"));
  if (watchSessions.length === 0) {
    lines.push("  start Claude with the plugin or run `worktree-fleet status --refresh-current`");
  } else {
    for (const entry of watchSessions) {
      const session = entry.session;
      lines.push(`  ${bold(session.session_id.slice(0, 8))} ${session.agent_kind} ${dim(session.worktree_path)}`);
      lines.push(`    dirty:    ${formatList(session.dirty_files)}`);
      lines.push(`    touched:  ${formatList(entry.intent?.tool_touched ?? [])}`);
      lines.push(`    upcoming: ${formatList(entry.intent?.upcoming ?? [])}`);
      lines.push(`    contended:${entry.contended.length ? ` ${red(entry.contended.join(", "))}` : " -"}`);
      lines.push(`    pending:  ${formatPending(session)}`);
      lines.push(`    blocked:  ${formatBlocked(session)}`);
      lines.push(`    updated:  dirty ${ageLabel(session.dirty_refreshed_at)} ago, heartbeat ${ageLabel(session.heartbeat_at)} ago`);
    }
  }
  lines.push("");
  lines.push(bold("Recent Main Events"));
  if (!repo) {
    lines.push("  unavailable outside a git repo");
  } else if (events.length === 0) {
    lines.push("  none recorded for this repo");
  } else {
    for (const event of events) {
      lines.push(`  ${event.created_at}  ${pad(event.source, 12)} ${pad(event.ref, 14)} ${event.sha.slice(0, 12)}`);
    }
  }
  lines.push("");
  lines.push(dim("press Ctrl-C to stop; use `worktree-fleet sync` to force a safe catch-up"));
  return `${lines.join("\n")}\n`;
}

function buildWatchSessions(sessions: SessionState[], intents: Map<string, IntentState>): WatchSession[] {
  const entries: WatchSession[] = sessions
    .sort((a, b) => a.worktree_path.localeCompare(b.worktree_path))
    .map((session) => {
      const intent = intents.get(session.session_id) ?? null;
      const adapter = readAdapter(session.agent_kind) ?? readAdapter(session.agent_kind.replace("-code", "")) ?? null;
      return {
        session,
        intent,
        adapterMode: adapter?.mode ?? session.adapter,
        writeSet: uniqueStrings([
          ...session.dirty_files,
          ...(intent?.tool_touched ?? []),
          ...(intent?.upcoming ?? [])
        ]),
        contended: []
      } satisfies WatchSession;
    });

  for (const entry of entries) {
    const contended = new Set<string>();
    for (const other of entries) {
      if (entry === other) continue;
      for (const file of entry.writeSet) {
        if (other.writeSet.some((otherFile) => pathsOverlap(file, otherFile))) contended.add(file);
      }
    }
    entry.contended = [...contended].sort();
  }
  return entries;
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const normalizedLeft = left.endsWith("/") ? left : `${left}/`;
  const normalizedRight = right.endsWith("/") ? right : `${right}/`;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function fleetHealth(entries: WatchSession[]): "blocked" | "divergent" | "pending" | "contended" | "clean" {
  if (entries.some((entry) => entry.session.integration.blocked)) return "blocked";
  if (entries.some((entry) => entry.session.integration.divergent_targets.length > 0)) return "divergent";
  if (entries.some((entry) => entry.session.integration.pending)) return "pending";
  if (entries.some((entry) => entry.contended.length > 0)) return "contended";
  return "clean";
}

function nextAction(entries: WatchSession[]): string {
  const blocked = entries.find((entry) => entry.session.integration.blocked);
  if (blocked) {
    return `${red("blocked")} in ${blocked.session.session_id.slice(0, 8)}: ${blocked.session.integration.blocked_reason ?? "blocked"}. Resolve files, then run worktree-fleet sync.`;
  }
  const divergent = entries.find((entry) => entry.session.integration.divergent_targets.length > 0);
  if (divergent) {
    return `${yellow("divergent main targets")} visible. Reconcile the candidate SHAs before merging.`;
  }
  const pending = entries.find((entry) => entry.session.integration.pending);
  if (pending) {
    return `${yellow("pending main update")} for ${pending.session.session_id.slice(0, 8)}. Let the next Stop hook sync, or run worktree-fleet sync.`;
  }
  const contended = entries.find((entry) => entry.contended.length > 0);
  if (contended) {
    return `${yellow("contention")} on ${contended.contended.join(", ")}. Coordinate before overlapping edits continue.`;
  }
  return green("clean: no pending main update, conflict, divergence, or file contention visible");
}

function sessionStateLabel(session: SessionState): string {
  if (session.integration.blocked) return red("blocked");
  if (session.integration.divergent_targets.length > 0) return yellow("diverged");
  if (session.integration.pending) return yellow("pending");
  if (session.dirty_files.length > 0) return cyan("dirty");
  return green("clean");
}

function formatHealth(health: ReturnType<typeof fleetHealth>): string {
  if (health === "blocked") return red("blocked");
  if (health === "divergent") return yellow("divergent");
  if (health === "pending") return yellow("pending");
  if (health === "contended") return yellow("contended");
  return green("clean");
}

function formatPending(session: SessionState): string {
  if (!session.integration.pending) return "-";
  const pending = session.integration.pending;
  const divergent = session.integration.divergent_targets.map((target) => target.sha.slice(0, 12));
  const extra = divergent.length ? `; divergent ${divergent.join(", ")}` : "";
  return `${pending.sha.slice(0, 12)} from ${pending.source} ${pending.ref}${extra}`;
}

function formatBlocked(session: SessionState): string {
  if (!session.integration.blocked) return "-";
  const files = session.integration.blocked_files.length ? ` (${session.integration.blocked_files.join(", ")})` : "";
  return red(`${session.integration.blocked_reason ?? "blocked"}${files}`);
}

function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "-";
}

function ageLabel(iso: string): string {
  const age = Date.now() - Date.parse(iso);
  if (!Number.isFinite(age) || age < 0) return "?";
  const seconds = Math.floor(age / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function pad(value: string, length: number): string {
  const plain = stripAnsi(value);
  if (plain.length >= length) return `${value}${" ".repeat(Math.max(0, length - plain.length))}`;
  return `${value}${" ".repeat(length - plain.length)}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function color(code: string, value: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  return `\x1b[${code}m${value}\x1b[0m`;
}

function bold(value: string): string {
  return color("1", value);
}

function dim(value: string): string {
  return color("2", value);
}

function red(value: string): string {
  return color("31", value);
}

function green(value: string): string {
  return color("32", value);
}

function yellow(value: string): string {
  return color("33", value);
}

function cyan(value: string): string {
  return color("36", value);
}

function installAdapter(kind: string): void {
  if (kind === "codex") {
    const registration = registerAdapter({ kind, mode: "wrapper", packageBin: "fleet", command: "fleet codex", nativeLifecycle: false });
    console.log(`${registration.kind}    wrapper available via package bin: use \`${registration.command}\``);
    console.log(`codex    plugin scaffold: worktree-fleet plugin path codex`);
  } else if (kind === "claude") {
    const registration = registerAdapter({ kind, mode: "host-managed", packageBin: "worktree-fleet", command: null, nativeLifecycle: true });
    console.log(`${registration.kind}   host-managed native lifecycle recorded; CLI core is ready`);
  } else {
    const registration = registerAdapter({ kind, mode: "generic", packageBin: "worktree-fleet" });
    console.log(`${registration.kind} adapter: use ${registration.command}`);
  }
}

function parseAdapterFlags(args: string[]): { adapters: string[]; allAdapters: boolean; noAdapters: boolean } {
  const adapters: string[] = [];
  let allAdapters = false;
  let noAdapters = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--adapter" && args[index + 1]) {
      adapters.push(args[index + 1]);
      index += 1;
    } else if (arg === "--all-adapters") {
      allAdapters = true;
    } else if (arg === "--no-adapters") {
      noAdapters = true;
    }
  }
  return { adapters, allAdapters, noAdapters };
}

function enableRerere(): void {
  git(process.cwd(), ["config", "rerere.enabled", "true"]);
  git(process.cwd(), ["config", "rerere.autoupdate", "true"]);
}

function bootstrapClaudeSession(cwd: string) {
  ensureStateRoot();
  registerAdapter({ kind: "claude", mode: "native", packageBin: "worktree-fleet", command: null, nativeLifecycle: true });
  ensureRepoConfig(cwd);
  if (!managedHooksInstalled(cwd)) installHooks(cwd);
  git(cwd, ["config", "rerere.enabled", "true"]);
  git(cwd, ["config", "rerere.autoupdate", "true"]);
  return refreshSessionDirty(ensureClaudeSession(cwd));
}

function ensureClaudeSession(cwd: string) {
  ensureStateRoot();
  return ensureSession(cwd, "claude-code");
}

function claudeSessionContext(branch: string): string {
  return [
    "<worktree-fleet>",
    `worktree-fleet is active in this repo on branch ${branch}.`,
    "Critical workflow rules:",
    "- For any request to create, open, switch, inspect, clean up, remove, prune, or coordinate Git worktrees, load and use the Skill tool for `worktree-fleet:worktree` or `worktree-fleet:using-git-worktrees` before running shell commands.",
    "- In fleet-managed repos, worktree-fleet supersedes generic Git worktree guidance, including `superpowers:using-git-worktrees`; apply the fleet board/status check first even if another worktree skill is loaded.",
    "- Do not start with raw `git worktree add/remove/move/prune/repair` or `git branch -d/-D`. First use `worktree-fleet:worktree` or run `worktree-fleet status --refresh-current` and read the fleet board.",
    "- For catch-up with the integration branch, load/use `worktree-fleet:sync` before any `git pull`, `git merge main`, or `git rebase main` flow.",
    "- If a fleet hook blocks a Bash command, follow the hook message instead of bypassing it.",
    "</worktree-fleet>"
  ].join("\n");
}

function shouldInjectFleetWorktreePromptContext(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    /\bwork\s*tree(s)?\b/,
    /\bworktree(s)?\b/,
    /\bgo in (a )?work\s*tree\b/,
    /\binline execution\b/,
    /\bisolated (workspace|worktree|work tree)\b/,
    /\bsibling work\s*tree(s)?\b/,
    /\bparallel (agent|session|worktree|work tree)s?\b/,
    /\bcreate .{0,40}(workspace|worktree|work tree)\b/,
    /\bremove .{0,40}(worktree|work tree)\b/,
    /\bprune .{0,40}(worktree|work tree)\b/
  ].some((pattern) => pattern.test(normalized));
}

function claudeWorktreePromptContext(branch: string): string {
  return [
    "<worktree-fleet-prompt>",
    `This prompt appears to involve Git worktrees in a fleet-managed repo. Integration branch: ${branch}.`,
    "Use worktree-fleet before generic worktree guidance:",
    "- Prefer the slash command `/worktree-fleet:worktree` or the Skill tool `worktree-fleet:using-git-worktrees` / `worktree-fleet:worktree`.",
    "- This supersedes generic Git worktree workflows, including `superpowers:using-git-worktrees`, for this repo.",
    "- Start with `worktree-fleet status --refresh-current` and read the fleet board before raw `git worktree` mutations.",
    "- After creating or entering a worktree, run `worktree-fleet status --refresh-current` inside it; if pending is visible, run `worktree-fleet sync` before editing.",
    "</worktree-fleet-prompt>"
  ].join("\n");
}

function readHookInput(): Record<string, unknown> {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function extractToolPaths(input: Record<string, unknown>, cwd: string): string[] {
  const values: string[] = [];
  const repo = safe(() => getRepoInfo(cwd));
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if ((key === "file_path" || key === "path") && typeof nested === "string") {
        values.push(nested);
      } else {
        visit(nested);
      }
    }
  };
  visit(input.tool_input);
  return Array.from(new Set(values.map((entry) => {
    const normalized = entry.replace(/\\/g, "/");
    if (!repo || !path.isAbsolute(normalized)) return normalized;
    return path.relative(realPathBestEffort(repo.root), realPathBestEffort(normalized)).replace(/\\/g, "/");
  }))).sort();
}

function manualGitCatchupBlock(input: Record<string, unknown>, cwd: string): string | null {
  const command = bashCommand(input);
  if (!command) return null;

  const branch = safe(() => ensureRepoConfig(cwd).integration_branch) ?? "main";
  if (!isManualGitCatchup(command, branch)) return null;

  return [
    "worktree-fleet blocked manual Git catch-up.",
    `This repo's integration branch is ${branch}. Run worktree-fleet sync first so fleet can merge safely or report the exact block.`,
    "After sync reports merged/noop, retry the Git command only if it is still needed.",
    `blocked command: ${command.split(/\r?\n/, 1)[0].slice(0, 160)}`
  ].join("\n");
}

function manualGitWorktreeLifecycleBlock(input: Record<string, unknown>, session: ReturnType<typeof ensureSession>): string | null {
  const command = bashCommand(input);
  if (!command) return null;

  const stripped = stripContinuationCommands(command);
  const mutationIndex = firstManualWorktreeMutationIndex(stripped);
  if (mutationIndex === null) return null;

  const fleetCheckIndex = firstFleetWorktreeCheckIndex(stripped);
  if (fleetCheckIndex !== null && fleetCheckIndex < mutationIndex) return null;
  if (hasRecentFleetWorktreeCheck(session)) return null;
  if (/\bWORKTREE_FLEET_ALLOW_GIT_WORKTREE=1\b/.test(stripped)) return null;

  return [
    "worktree-fleet blocked manual Git worktree lifecycle command.",
    "Use the worktree-fleet:worktree skill for worktree creation/removal, or run worktree-fleet status --refresh-current first so fleet can surface active sessions, dirty files, intent, pending updates, and blocked work before changing worktrees.",
    "After the fleet check, rerun the Git command only if it still makes sense.",
    "For a newly-created worktree, run worktree-fleet status --refresh-current inside it before editing.",
    `blocked command: ${command.split(/\r?\n/, 1)[0].slice(0, 160)}`
  ].join("\n");
}

function bashCommand(input: Record<string, unknown>): string | null {
  if (input.tool_name !== "Bash") return null;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command : null;
}

function isManualGitCatchup(command: string, integrationBranch: string): boolean {
  const stripped = stripContinuationCommands(command);
  const branch = escapeRegExp(integrationBranch);
  const target = `(?:origin/|refs/heads/|refs/remotes/origin/)?${branch}`;

  if (/\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+pull\b/.test(stripped)) return true;

  const rebase = new RegExp(`\\bgit(?:\\s+-C\\s+(?:"[^"]+"|'[^']+'|\\S+))?\\s+rebase\\b([^;&|\\n]*)`, "g");
  for (const match of stripped.matchAll(rebase)) {
    const args = match[1] ?? "";
    if (/\s--(?:continue|abort|skip)\b/.test(args)) continue;
    if (new RegExp(`(^|\\s)${target}(\\s|$)`).test(args)) return true;
  }

  const merge = new RegExp(`\\bgit(?:\\s+-C\\s+(?:"[^"]+"|'[^']+'|\\S+))?\\s+merge\\b([^;&|\\n]*)`, "g");
  for (const match of stripped.matchAll(merge)) {
    const args = match[1] ?? "";
    if (/\s--(?:abort|continue|quit)\b/.test(args)) continue;
    if (new RegExp(`(^|\\s)${target}(\\s|$)`).test(args)) return true;
  }

  return false;
}

function firstManualWorktreeMutationIndex(command: string): number | null {
  const indexes: number[] = [];
  const gitPrefix = String.raw`\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?`;
  const worktree = new RegExp(`${gitPrefix}\\s+worktree\\s+(?:add|remove|move|prune|repair)\\b`, "g");
  const branchDelete = new RegExp(`${gitPrefix}\\s+branch\\s+-(?:d|D)\\b`, "g");
  for (const match of command.matchAll(worktree)) indexes.push(match.index ?? 0);
  for (const match of command.matchAll(branchDelete)) indexes.push(match.index ?? 0);
  return indexes.length ? Math.min(...indexes) : null;
}

function firstFleetWorktreeCheckIndex(command: string): number | null {
  const checks = /\bworktree-fleet\s+(?:status|sync|watch)\b/g;
  const match = checks.exec(command);
  return match?.index ?? null;
}

function isFleetWorktreeCheck(command: string): boolean {
  return firstFleetWorktreeCheckIndex(stripContinuationCommands(command)) !== null;
}

function hasRecentFleetWorktreeCheck(session: ReturnType<typeof ensureSession>): boolean {
  const checkedAt = ensureIntent(session.session_id).last_fleet_check_at;
  if (!checkedAt) return false;
  const age = Date.now() - Date.parse(checkedAt);
  return !Number.isNaN(age) && age >= 0 && age <= FLEET_WORKTREE_CHECK_TTL_MS;
}

function stripContinuationCommands(command: string): string {
  return command
    .replace(/\\\r?\n/g, " ")
    .replace(/^\s*#.*$/gm, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function realPathBestEffort(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

function blockKey(session: ReturnType<typeof ensureSession>): string | null {
  if (!session.integration.blocked) return null;
  const pending = session.integration.pending?.sha ?? "-";
  const divergent = session.integration.divergent_targets.map((target) => target.sha).sort().join(",");
  const files = [...session.integration.blocked_files].sort().join(",");
  return [pending, divergent, session.integration.blocked_reason ?? "-", files].join("|");
}

function formatClaudeBlockMessage(session: ReturnType<typeof ensureSession>): string {
  const pending = session.integration.pending?.sha.slice(0, 12) ?? "-";
  const divergent = session.integration.divergent_targets.map((target) => target.sha.slice(0, 12)).join(", ") || "-";
  const files = session.integration.blocked_files.length ? session.integration.blocked_files.join(", ") : "-";
  return [
    `worktree-fleet blocked sync: ${session.integration.blocked_reason ?? "blocked"}`,
    `pending main target: ${pending}`,
    `divergent targets: ${divergent}`,
    `files: ${files}`,
    "Resolve the block or ask the user before continuing unrelated work."
  ].join("\n");
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

if (isDirectRun()) {
  const code = await main();
  process.exitCode = code;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(fs.realpathSync.native(process.argv[1])).href;
}
