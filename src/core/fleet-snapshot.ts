import { listAdapters, readAdapter } from "./adapters.js";
import { listActivity } from "./activity.js";
import { listMainEvents } from "./events.js";
import { ensureStateRoot } from "./init.js";
import { stateRoot } from "./paths.js";
import { ensureRepoConfig } from "./repo-config.js";
import { ensureSession, listIntents, listSessions, refreshSessionDirty } from "./session.js";
import type { ActivityEvent, AdapterRegistration, IntentState, MainEvent, PendingTarget, SessionState } from "./types.js";
import { getRepoInfo } from "../git/repo.js";
import { managedHooksInstalled } from "../hooks/install.js";

const ACTIVE_HEARTBEAT_MS = 30 * 1000;
const IDLE_HEARTBEAT_MS = 2 * 60 * 1000;
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

export type CheckStatus = "ok" | "warn" | "bad" | "unknown";
export type FleetStatus = "working" | "attention" | "blocked" | "unknown";
export type SessionLifecycleStatus = "active" | "idle" | "stale" | "offline" | "unknown";

export interface FleetSnapshotOptions {
  cwd?: string;
  refreshCurrent?: boolean;
  activityLimit?: number;
  now?: Date;
}

export interface FleetSnapshot {
  generated_at: string;
  working: {
    observing: boolean;
    status: FleetStatus;
    label: string;
    detail: string;
  };
  summary: {
    next_action: string;
    active_sessions: number;
    at_risk_sessions: number;
    dirty_files: number;
    pending_sessions: number;
    contended_sessions: number;
    blocked_sessions: number;
    divergent_sessions: number;
  };
  repo: {
    root: string | null;
    repo_id: string | null;
    branch: string | null;
    integration_branch: string | null;
    integration_remote_ref: string | null;
    hooks: "ok" | "missing" | "unknown";
    state_root: string;
  };
  checks: FleetCheck[];
  sessions: FleetSessionSnapshot[];
  coordination: {
    latest_main_event: MainEventSummary | null;
    pending_sessions: string[];
    blocked_sessions: string[];
    divergent_sessions: string[];
    contended_sessions: string[];
    contended_files: string[];
  };
  main_events: MainEventSummary[];
  activity: ActivityEventSummary[];
  adapters: AdapterSummary[];
}

export interface FleetCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  evidence: string;
}

export interface FleetSessionSnapshot {
  id: string;
  short_id: string;
  agent_kind: string;
  adapter_mode: string;
  adapter_label: string;
  branch: string;
  worktree_path: string;
  worktree_name: string;
  pid: number;
  pid_alive: boolean | null;
  lifecycle: {
    status: SessionLifecycleStatus;
    label: string;
    detail: string;
  };
  heartbeat_age_ms: number | null;
  heartbeat_age_label: string;
  dirty_age_ms: number | null;
  dirty_age_label: string;
  dirty_files: string[];
  touched_files: string[];
  upcoming_files: string[];
  dirty_count: number;
  touched_count: number;
  upcoming_count: number;
  contended_files: string[];
  integration: {
    pending_sha: string | null;
    pending_source: string | null;
    pending_ref: string | null;
    blocked: boolean;
    blocked_reason: string | null;
    blocked_files: string[];
    divergent_targets: MainEventSummary[];
    last_absorbed_event_id: string | null;
    caught_up_to_latest_event: boolean | null;
  };
}

export interface MainEventSummary {
  event_id: string;
  created_at: string;
  age_label: string;
  source: string;
  ref: string;
  sha: string;
  short_sha: string;
}

export interface ActivityEventSummary {
  activity_id: string;
  created_at: string;
  age_label: string;
  kind: string;
  summary: string;
  session_id: string | null;
  short_session_id: string | null;
  worktree_path: string | null;
}

export interface AdapterSummary {
  kind: string;
  mode: string;
  native_lifecycle: boolean;
  command: string | null;
  notes: string[];
}

interface WatchSessionEntry {
  session: SessionState;
  intent: IntentState | null;
  adapterMode: string;
  writeSet: string[];
  contended: string[];
}

export function buildFleetSnapshot(options: FleetSnapshotOptions = {}): FleetSnapshot {
  ensureStateRoot();
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const repo = safe(() => getRepoInfo(cwd));
  const currentSession = repo && options.refreshCurrent !== false
    ? safe(() => refreshSessionDirty(ensureSession(repo.root)))
    : null;
  const repoConfig = repo ? safe(() => ensureRepoConfig(repo.root)) : null;
  const hooksOk = repo ? safe(() => managedHooksInstalled(repo.root)) === true : false;
  const intents = new Map(listIntents().map((intentState) => [intentState.session_id, intentState]));
  const sessions = listSessions()
    .filter((session) => !repo || session.repo_id === repo.repoId);
  const entries = buildSessionEntries(sessions, intents);
  const mainEvents = repo ? listMainEvents(repo.repoId).slice(-12).reverse().map((event) => summarizeMainEvent(event, now)) : [];
  const latestMainEvent = mainEvents[0] ?? null;
  const sessionSnapshots = entries.map((entry) => summarizeSession(entry, latestMainEvent, now));
  const adapters = listAdapters().map(summarizeAdapter);
  const activity = listActivity({ repoId: repo?.repoId ?? null, limit: options.activityLimit ?? 30 }).map((event) => summarizeActivity(event, now));
  const checks = buildChecks({
    repoPresent: Boolean(repo),
    hooksOk,
    currentSessionPresent: Boolean(currentSession ?? (repo && sessionSnapshots.some((session) => session.worktree_path === repo.root))),
    sessions: sessionSnapshots,
    adapters,
    mainEvents,
    state: stateRoot()
  });
  const summary = buildSummary(sessionSnapshots);
  const working = buildWorkingState(repo, hooksOk, sessionSnapshots, summary);
  return {
    generated_at: generatedAt,
    working,
    summary: {
      ...summary,
      next_action: nextAction(repo, hooksOk, sessionSnapshots)
    },
    repo: {
      root: repo?.root ?? null,
      repo_id: repo?.repoId ?? null,
      branch: repo?.branch ?? null,
      integration_branch: repoConfig?.integration_branch ?? null,
      integration_remote_ref: repoConfig?.integration_remote_ref ?? null,
      hooks: repo ? (hooksOk ? "ok" : "missing") : "unknown",
      state_root: stateRoot()
    },
    checks,
    sessions: sessionSnapshots,
    coordination: {
      latest_main_event: latestMainEvent,
      pending_sessions: sessionSnapshots.filter((session) => session.integration.pending_sha).map((session) => session.short_id),
      blocked_sessions: sessionSnapshots.filter((session) => session.integration.blocked).map((session) => session.short_id),
      divergent_sessions: sessionSnapshots.filter((session) => session.integration.divergent_targets.length > 0).map((session) => session.short_id),
      contended_sessions: sessionSnapshots.filter((session) => session.contended_files.length > 0).map((session) => session.short_id),
      contended_files: uniqueStrings(sessionSnapshots.flatMap((session) => session.contended_files))
    },
    main_events: mainEvents,
    activity,
    adapters
  };
}

function buildSessionEntries(sessions: SessionState[], intents: Map<string, IntentState>): WatchSessionEntry[] {
  const entries: WatchSessionEntry[] = sessions
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
      };
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

function summarizeSession(entry: WatchSessionEntry, latestMainEvent: MainEventSummary | null, now: Date): FleetSessionSnapshot {
  const session = entry.session;
  const pidAlive = processAlive(session.pid);
  const heartbeatAgeMs = ageMs(session.heartbeat_at, now);
  const dirtyAgeMs = ageMs(session.dirty_refreshed_at, now);
  const lifecycle = classifyLifecycle({ pidAlive, heartbeatAgeMs });
  const pending = session.integration.pending;
  return {
    id: session.session_id,
    short_id: session.session_id.slice(0, 8),
    agent_kind: session.agent_kind,
    adapter_mode: entry.adapterMode,
    adapter_label: `${session.agent_kind}/${entry.adapterMode}`,
    branch: session.branch,
    worktree_path: session.worktree_path,
    worktree_name: session.worktree_path.split("/").filter(Boolean).at(-1) ?? session.worktree_path,
    pid: session.pid,
    pid_alive: pidAlive,
    lifecycle,
    heartbeat_age_ms: heartbeatAgeMs,
    heartbeat_age_label: ageLabelFromMs(heartbeatAgeMs),
    dirty_age_ms: dirtyAgeMs,
    dirty_age_label: ageLabelFromMs(dirtyAgeMs),
    dirty_files: session.dirty_files,
    touched_files: entry.intent?.tool_touched ?? [],
    upcoming_files: entry.intent?.upcoming ?? [],
    dirty_count: session.dirty_files.length,
    touched_count: entry.intent?.tool_touched.length ?? 0,
    upcoming_count: entry.intent?.upcoming.length ?? 0,
    contended_files: entry.contended,
    integration: {
      pending_sha: pending?.sha ?? null,
      pending_source: pending?.source ?? null,
      pending_ref: pending?.ref ?? null,
      blocked: session.integration.blocked,
      blocked_reason: session.integration.blocked_reason,
      blocked_files: session.integration.blocked_files,
      divergent_targets: session.integration.divergent_targets.map((target) => summarizeMainEvent(target, now)),
      last_absorbed_event_id: session.last_absorbed_event_id,
      caught_up_to_latest_event: latestMainEvent ? session.last_absorbed_event_id === latestMainEvent.event_id : null
    }
  };
}

function buildChecks(input: {
  repoPresent: boolean;
  hooksOk: boolean;
  currentSessionPresent: boolean;
  sessions: FleetSessionSnapshot[];
  adapters: AdapterSummary[];
  mainEvents: MainEventSummary[];
  state: string;
}): FleetCheck[] {
  const offline = input.sessions.filter((session) => session.lifecycle.status === "offline");
  const stale = input.sessions.filter((session) => session.lifecycle.status === "stale");
  const pending = input.sessions.filter((session) => session.integration.pending_sha);
  const blocked = input.sessions.filter((session) => session.integration.blocked);
  const divergent = input.sessions.filter((session) => session.integration.divergent_targets.length > 0);
  const contended = input.sessions.filter((session) => session.contended_files.length > 0);
  return [
    {
      id: "repo",
      label: "Repo detected",
      status: input.repoPresent ? "ok" : "bad",
      detail: input.repoPresent ? "Running inside a git worktree." : "No git repo found for this observer.",
      evidence: input.repoPresent ? "git root resolved" : "open from a fleet-managed repo"
    },
    {
      id: "state",
      label: "State store readable",
      status: "ok",
      detail: "Fleet state is readable and writable.",
      evidence: input.state
    },
    {
      id: "hooks",
      label: "Safety hooks",
      status: !input.repoPresent ? "unknown" : input.hooksOk ? "ok" : "bad",
      detail: input.hooksOk ? "Managed git hooks are installed." : "Managed git hooks are missing.",
      evidence: input.hooksOk ? "post-commit and guards present" : "run worktree-fleet setup"
    },
    {
      id: "current-session",
      label: "Current worktree registered",
      status: !input.repoPresent ? "unknown" : input.currentSessionPresent ? "ok" : "bad",
      detail: input.currentSessionPresent ? "This worktree has a visible fleet session." : "This worktree is not currently registered.",
      evidence: input.currentSessionPresent ? "session record refreshed" : "status --refresh-current would create one"
    },
    {
      id: "agent-health",
      label: "Agent heartbeats",
      status: offline.length > 0 ? "bad" : stale.length > 0 ? "warn" : input.sessions.length > 0 ? "ok" : "warn",
      detail: agentHealthDetail(input.sessions, stale, offline),
      evidence: input.sessions.length ? input.sessions.map((session) => `${session.short_id} ${session.lifecycle.status}`).join(", ") : "no sessions"
    },
    {
      id: "integration",
      label: "Integration catch-up",
      status: blocked.length || divergent.length ? "bad" : pending.length ? "warn" : "ok",
      detail: integrationDetail(pending, blocked, divergent),
      evidence: input.mainEvents[0] ? `latest ${input.mainEvents[0].short_sha} ${input.mainEvents[0].age_label} ago` : "no main events recorded"
    },
    {
      id: "contention",
      label: "File contention",
      status: contended.length ? "warn" : "ok",
      detail: contended.length ? `${contended.length} session(s) overlap on planned or dirty paths.` : "No overlapping dirty, touched, or upcoming paths.",
      evidence: contended.length ? uniqueStrings(contended.flatMap((session) => session.contended_files)).join(", ") : "write sets do not overlap"
    },
    {
      id: "adapters",
      label: "Adapter registrations",
      status: input.adapters.length ? "ok" : "warn",
      detail: input.adapters.length ? `${input.adapters.length} adapter(s) registered.` : "No adapter registration is visible.",
      evidence: input.adapters.length ? input.adapters.map((adapter) => `${adapter.kind}/${adapter.mode}`).join(", ") : "setup --adapter records one"
    }
  ];
}

function buildSummary(sessions: FleetSessionSnapshot[]): Omit<FleetSnapshot["summary"], "next_action"> {
  return {
    active_sessions: sessions.filter((session) => session.lifecycle.status === "active").length,
    at_risk_sessions: sessions.filter((session) => ["stale", "offline", "unknown"].includes(session.lifecycle.status)).length,
    dirty_files: sessions.reduce((sum, session) => sum + session.dirty_count, 0),
    pending_sessions: sessions.filter((session) => session.integration.pending_sha).length,
    contended_sessions: sessions.filter((session) => session.contended_files.length > 0).length,
    blocked_sessions: sessions.filter((session) => session.integration.blocked).length,
    divergent_sessions: sessions.filter((session) => session.integration.divergent_targets.length > 0).length
  };
}

function buildWorkingState(
  repo: ReturnType<typeof getRepoInfo> | null,
  hooksOk: boolean,
  sessions: FleetSessionSnapshot[],
  summary: Omit<FleetSnapshot["summary"], "next_action">
): FleetSnapshot["working"] {
  if (!repo) {
    return {
      observing: false,
      status: "unknown",
      label: "Not observing",
      detail: "Open the observer from inside a git worktree."
    };
  }
  if (!hooksOk || summary.blocked_sessions > 0 || summary.divergent_sessions > 0) {
    return {
      observing: hooksOk,
      status: "blocked",
      label: "Needs attention",
      detail: !hooksOk ? "Fleet safety hooks are missing." : "A sync block or divergent target needs a human decision."
    };
  }
  if (summary.pending_sessions > 0 || summary.contended_sessions > 0 || summary.at_risk_sessions > 0) {
    return {
      observing: true,
      status: "attention",
      label: "Observing with risk",
      detail: "Fleet is running and has something worth checking."
    };
  }
  return {
    observing: true,
    status: "working",
    label: "Fleet is observing",
    detail: sessions.length ? `${sessions.length} session(s) visible and no coordination risk detected.` : "Fleet is ready, but no active agent sessions are visible."
  };
}

function nextAction(repo: ReturnType<typeof getRepoInfo> | null, hooksOk: boolean, sessions: FleetSessionSnapshot[]): string {
  if (!repo) return "Open worktree-fleet observe inside a git repo so fleet can resolve worktree state.";
  if (!hooksOk) return "Run worktree-fleet setup in this repo; the safety hooks that record main movement are missing.";
  const offline = sessions.find((session) => session.lifecycle.status === "offline");
  if (offline) return `${offline.short_id} has not heartbeated for ${offline.heartbeat_age_label}. Restart that agent or let fleet clean up the stale session.`;
  const blocked = sessions.find((session) => session.integration.blocked);
  if (blocked) return `${blocked.short_id} is blocked: ${blocked.integration.blocked_reason ?? "sync blocked"}. Resolve the listed files, then run worktree-fleet sync.`;
  const divergent = sessions.find((session) => session.integration.divergent_targets.length > 0);
  if (divergent) return `${divergent.short_id} sees divergent main targets. Reconcile the candidate SHAs before merging.`;
  const pending = sessions.find((session) => session.integration.pending_sha);
  if (pending) return `${pending.short_id} has a pending main update ${pending.integration.pending_sha?.slice(0, 12)}. Let the next stop hook sync, or run worktree-fleet sync.`;
  const contended = sessions.find((session) => session.contended_files.length > 0);
  if (contended) return `${contended.short_id} overlaps another session on ${contended.contended_files.slice(0, 3).join(", ")}. Coordinate before continuing.`;
  const stale = sessions.find((session) => session.lifecycle.status === "stale");
  if (stale) return `${stale.short_id} has not heartbeated for ${stale.heartbeat_age_label}. Check whether that agent is idle or stuck.`;
  if (sessions.length === 0) return "Fleet is set up, but no active agent sessions are registered yet.";
  return `All clear. ${sessions.length} session(s) visible, hooks installed, no pending main update, block, divergence, or contention.`;
}

function classifyLifecycle(input: { pidAlive: boolean | null; heartbeatAgeMs: number | null }): FleetSessionSnapshot["lifecycle"] {
  if (input.heartbeatAgeMs === null) {
    return {
      status: "unknown",
      label: "Unknown",
      detail: "Heartbeat timestamp could not be read."
    };
  }
  if (input.heartbeatAgeMs <= ACTIVE_HEARTBEAT_MS) {
    return {
      status: "active",
      label: "Active",
      detail: input.pidAlive === false
        ? "The recorded helper PID has exited, but the heartbeat is fresh; this is normal for hook-backed sessions."
        : "Heartbeat was refreshed recently."
    };
  }
  if (input.heartbeatAgeMs <= IDLE_HEARTBEAT_MS) {
    return {
      status: "idle",
      label: "Idle",
      detail: "Heartbeat is a little old, but still within the normal window."
    };
  }
  if (input.heartbeatAgeMs <= STALE_HEARTBEAT_MS) {
    return {
      status: "stale",
      label: "Stale",
      detail: input.pidAlive === false
        ? "Heartbeat is old and the recorded helper PID has exited."
        : "Heartbeat is old enough to deserve a check."
    };
  }
  return {
    status: "offline",
    label: "Not heartbeating",
    detail: input.pidAlive === false
      ? "No fresh heartbeat; the recorded helper PID has also exited."
      : "Heartbeat is beyond the fleet freshness window."
  };
}

function summarizeMainEvent(event: MainEvent | PendingTarget, now: Date): MainEventSummary {
  return {
    event_id: event.event_id,
    created_at: event.created_at,
    age_label: ageLabelFromMs(ageMs(event.created_at, now)),
    source: event.source,
    ref: event.ref,
    sha: event.sha,
    short_sha: event.sha.slice(0, 12)
  };
}

function summarizeActivity(event: ActivityEvent, now: Date): ActivityEventSummary {
  return {
    activity_id: event.activity_id,
    created_at: event.created_at,
    age_label: ageLabelFromMs(ageMs(event.created_at, now)),
    kind: event.kind,
    summary: event.summary,
    session_id: event.session_id,
    short_session_id: event.session_id?.slice(0, 8) ?? null,
    worktree_path: event.worktree_path
  };
}

function summarizeAdapter(adapter: AdapterRegistration): AdapterSummary {
  return {
    kind: adapter.kind,
    mode: adapter.mode,
    native_lifecycle: adapter.native_lifecycle,
    command: adapter.command,
    notes: adapter.notes
  };
}

function agentHealthDetail(
  sessions: FleetSessionSnapshot[],
  stale: FleetSessionSnapshot[],
  offline: FleetSessionSnapshot[]
): string {
  if (offline.length) return `${offline.length} registered session(s) are not running.`;
  if (stale.length) return `${stale.length} session(s) have stale heartbeats.`;
  if (sessions.length) return `${sessions.length} session(s) are visible and heartbeating.`;
  return "No agent sessions are currently visible.";
}

function integrationDetail(
  pending: FleetSessionSnapshot[],
  blocked: FleetSessionSnapshot[],
  divergent: FleetSessionSnapshot[]
): string {
  if (blocked.length) return `${blocked.length} session(s) are blocked from syncing.`;
  if (divergent.length) return `${divergent.length} session(s) see divergent main targets.`;
  if (pending.length) return `${pending.length} session(s) have pending main updates.`;
  return "No pending, blocked, or divergent main updates.";
}

function processAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

function ageMs(iso: string, now: Date): number | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const age = now.getTime() - parsed;
  return age < 0 ? 0 : age;
}

function ageLabelFromMs(ms: number | null): string {
  if (ms === null) return "?";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
