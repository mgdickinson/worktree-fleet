import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist/cli/index.js");

function makeTempRepo(branch = "main") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fleet-test-"));
  const repo = path.join(tmp, "repo");
  const state = path.join(tmp, "state");
  fs.mkdirSync(repo);
  run("git", ["init", "-q", "-b", branch], repo);
  run("git", ["config", "user.email", "test@example.com"], repo);
  run("git", ["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "one\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "initial"], repo);
  return { tmp, repo, state };
}

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

function cliRun(args, cwd, state) {
  return run("node", [cli, ...args], cwd, { WORKTREE_FLEET_HOME: state });
}

test("setup installs quiet hooks and writes colon-free main events", () => {
  const { repo, state } = makeTempRepo();
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);

  fs.appendFileSync(path.join(repo, "file.txt"), "two\n");
  run("git", ["add", "file.txt"], repo);
  const commitOutput = run("git", ["commit", "-m", "second"], repo, { WORKTREE_FLEET_HOME: state });

  assert.match(commitOutput, /\[main [0-9a-f]+\] second/);
  assert.doesNotMatch(commitOutput, /worktree-fleet|wrote /);
  const hook = fs.readFileSync(path.join(repo, ".git", "hooks", "post-commit"), "utf8");
  assert.match(hook, new RegExp(`${escapeRegExp(path.join(state, "bin", "worktree-fleet-hook"))}`));
  assert.ok(fs.existsSync(path.join(state, "bin", "worktree-fleet-hook")));

  const events = fs.readdirSync(path.join(state, "bus", "main-events"));
  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0], /:/);
  assert.match(events[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/);
});

test("setup prunes older hook runtime snapshots", () => {
  const { repo, state } = makeTempRepo();
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  const runtimeRoot = path.join(state, "runtime");
  const first = fs.readdirSync(runtimeRoot);
  assert.equal(first.length, 1);

  const stale = path.join(runtimeRoot, "stale-runtime");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "marker"), "old\n");

  cliRun(["init"], repo, state);
  const snapshots = fs.readdirSync(runtimeRoot).sort();
  assert.equal(snapshots.length, 1);
  assert.notEqual(snapshots[0], "stale-runtime");
});

test("setup detects and emits events for a non-main integration branch", () => {
  const { repo, state } = makeTempRepo("trunk");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);

  fs.appendFileSync(path.join(repo, "file.txt"), "two\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "second"], repo, { WORKTREE_FLEET_HOME: state });

  const configFile = findRepoConfig(state);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(config.integration_branch, "trunk");
  const events = fs.readdirSync(path.join(state, "bus", "main-events"));
  assert.equal(events.length, 1);
});

test("setup records explicit adapter consent and exposes the Codex plugin scaffold", () => {
  const { repo, state } = makeTempRepo();
  const output = cliRun(["setup", "--yes", "--adapter", "codex"], repo, state);
  assert.match(output, /wrapper available/);
  assert.match(output, /plugin scaffold/);

  const adapterFile = path.join(state, "adapters", "codex.json");
  const adapter = JSON.parse(fs.readFileSync(adapterFile, "utf8"));
  assert.equal(adapter.kind, "codex");
  assert.equal(adapter.mode, "wrapper");
  assert.equal(adapter.native_lifecycle, false);

  const pluginPath = cliRun(["plugin", "path", "codex"], repo, state).trim();
  assert.equal(path.basename(pluginPath), "worktree-fleet-codex");
  assert.ok(fs.existsSync(path.join(pluginPath, ".codex-plugin", "plugin.json")));

  const listOutput = cliRun(["adapter", "list"], repo, state);
  assert.match(listOutput, /codex\s+mode=wrapper/);
});

test("claude hook bootstraps plugin sessions and tool intent", () => {
  const { repo, state } = makeTempRepo();
  const sessionStart = spawnSync("node", [cli, "claude-hook"], {
    cwd: repo,
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: repo }),
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });
  assert.equal(sessionStart.status, 0, sessionStart.stderr);
  assert.match(sessionStart.stdout, /worktree-fleet active/);

  const adapter = JSON.parse(fs.readFileSync(path.join(state, "adapters", "claude.json"), "utf8"));
  assert.equal(adapter.mode, "native");
  const sessionFile = fs.readdirSync(path.join(state, "sessions")).find((entry) => entry.endsWith(".json"));
  assert.ok(sessionFile);
  let session = JSON.parse(fs.readFileSync(path.join(state, "sessions", sessionFile), "utf8"));
  assert.equal(session.agent_kind, "claude-code");

  const preTool = spawnSync("node", [cli, "claude-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "file.txt") }
    }),
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });
  assert.equal(preTool.status, 0, preTool.stderr);
  const intent = JSON.parse(fs.readFileSync(path.join(state, "intents", sessionFile), "utf8"));
  assert.ok(intent.tool_touched.includes("file.txt"));

  const manualRebase = spawnSync("node", [cli, "claude-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git rebase main" }
    }),
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });
  assert.equal(manualRebase.status, 2);
  assert.match(manualRebase.stderr, /worktree-fleet blocked manual Git catch-up/);
  assert.match(manualRebase.stderr, /worktree-fleet sync first/);

  const rebaseContinue = spawnSync("node", [cli, "claude-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git rebase --continue" }
    }),
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });
  assert.equal(rebaseContinue.status, 0, rebaseContinue.stderr);

  const sessionEnd = spawnSync("node", [cli, "claude-hook"], {
    cwd: repo,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }),
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });
  assert.equal(sessionEnd.status, 0, sessionEnd.stderr);
  session = fs.existsSync(path.join(state, "sessions", sessionFile))
    ? JSON.parse(fs.readFileSync(path.join(state, "sessions", sessionFile), "utf8"))
    : null;
  assert.equal(session, null);
});

test("watch renders a one-shot fleet dashboard", () => {
  const { repo, state } = makeTempRepo();
  cliRun(["setup", "--yes", "--adapter", "claude"], repo, state);
  cliRun(["status", "--refresh-current"], repo, state);
  fs.writeFileSync(path.join(repo, "local.txt"), "local\n");

  const output = cliRun(["watch", "--once"], repo, state);
  assert.match(output, /worktree-fleet watch/);
  assert.match(output, /Next Action/);
  assert.match(output, /Sessions/);
  assert.match(output, /Details/);
  assert.match(output, /Recent Main Events/);
  assert.match(output, /local\.txt/);
});

test("activity records durable usage artifacts", () => {
  const { repo, state } = makeTempRepo();
  cliRun(["setup", "--yes", "--adapter", "claude"], repo, state);
  cliRun(["status", "--refresh-current"], repo, state);
  cliRun(["intent", "declare", "app/patient_tasks.rb"], repo, state);

  const output = cliRun(["activity", "--limit", "10"], repo, state);
  assert.match(output, /worktree-fleet activity/);
  assert.match(output, /repo-setup/);
  assert.match(output, /session-started/);
  assert.match(output, /intent-declared/);

  const json = JSON.parse(cliRun(["activity", "--limit", "10", "--json"], repo, state));
  assert.ok(json.some((event) => event.kind === "intent-declared"));
  assert.ok(fs.readdirSync(path.join(state, "activity")).some((entry) => entry.endsWith(".jsonl")));
});

test("sync merges a clean main event into a sibling worktree", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.appendFileSync(path.join(repo, "file.txt"), "two\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "second"], repo, { WORKTREE_FLEET_HOME: state });

  const output = cliRun(["sync"], wt, state);
  assert.match(output, /merged/);
  assert.equal(run("git", ["rev-parse", "HEAD"], wt), run("git", ["rev-parse", "HEAD"], repo));
});

test("sync records an event cursor after absorbing main events", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.appendFileSync(path.join(repo, "file.txt"), "two\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "second"], repo, { WORKTREE_FLEET_HOME: state });

  cliRun(["sync"], wt, state);
  const sessionFile = fs.readdirSync(path.join(state, "sessions")).find((entry) => entry.endsWith(".json"));
  assert.ok(sessionFile);
  const session = JSON.parse(fs.readFileSync(path.join(state, "sessions", sessionFile), "utf8"));
  assert.match(session.last_absorbed_event_id, /-.*-[0-9a-f]{40}$/);

  const second = cliRun(["sync"], wt, state);
  assert.match(second, /no pending main target|pending target already integrated/);
});

test("sidecar fetch tick publishes remote integration branch events", () => {
  const { repo, state, tmp } = makeTempRepo();
  const remote = path.join(tmp, "remote.git");
  const wt = path.join(tmp, "wt");
  const writer = path.join(tmp, "writer");
  run("git", ["init", "--bare", "-q", "-b", "main", remote], tmp);
  run("git", ["remote", "add", "origin", remote], repo);
  run("git", ["push", "-q", "-u", "origin", "main"], repo);

  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  run("git", ["clone", "-q", remote, writer], tmp);
  run("git", ["config", "user.email", "test@example.com"], writer);
  run("git", ["config", "user.name", "Test"], writer);
  fs.appendFileSync(path.join(writer, "file.txt"), "remote\n");
  run("git", ["add", "file.txt"], writer);
  run("git", ["commit", "-q", "-m", "remote-main"], writer);
  run("git", ["push", "-q", "origin", "main"], writer);

  const result = spawnSync("node", [
    cli,
    "session",
    "start",
    "--agent",
    "generic-cli",
    "--",
    "node",
    "-e",
    "setTimeout(() => {}, 650)"
  ], {
    cwd: wt,
    env: {
      ...process.env,
      WORKTREE_FLEET_HOME: state,
      WORKTREE_FLEET_TICK_MS: "100",
      WORKTREE_FLEET_FETCH_INTERVAL_MS: "0"
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const eventFiles = fs.readdirSync(path.join(state, "bus", "main-events"));
  const events = eventFiles.map((file) => JSON.parse(fs.readFileSync(path.join(state, "bus", "main-events", file), "utf8")));
  assert.ok(events.some((event) => event.source === "remote-main" && event.ref === "origin/main"));
});

test("sync blocks when the index has staged changes", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.writeFileSync(path.join(wt, "local.txt"), "local\n");
  run("git", ["add", "local.txt"], wt);

  fs.appendFileSync(path.join(repo, "file.txt"), "two\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "second"], repo, { WORKTREE_FLEET_HOME: state });

  const output = cliRun(["sync"], wt, state);
  assert.match(output, /index has staged changes/);
});

test("sync blocks on dirty overlap", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.writeFileSync(path.join(wt, "file.txt"), "local change\n");

  fs.writeFileSync(path.join(repo, "file.txt"), "main change\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "main-change"], repo, { WORKTREE_FLEET_HOME: state });

  const output = cliRun(["sync"], wt, state);
  assert.match(output, /dirty overlap/);
});

test("sync blocks active merge operations before staged-index logic", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.writeFileSync(path.join(repo, "file.txt"), "main change\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "main-change"], repo, { WORKTREE_FLEET_HOME: state });

  fs.writeFileSync(path.join(wt, "local.txt"), "staged\n");
  run("git", ["add", "local.txt"], wt);
  const gitDir = run("git", ["rev-parse", "--path-format=absolute", "--git-dir"], wt).trim();
  fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), run("git", ["rev-parse", "HEAD"], repo));

  const output = cliRun(["sync"], wt, state);
  assert.match(output, /git operation in progress: merge/);
});

test("hook install preserves user hook content and uninstall removes only managed block", () => {
  const { repo, state } = makeTempRepo();
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, "#!/bin/sh\necho user-hook\n", { mode: 0o755 });

  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  const installed = fs.readFileSync(hookPath, "utf8");
  assert.match(installed, /echo user-hook/);
  assert.match(installed, /worktree-fleet managed block/);

  cliRun(["uninstall"], repo, state);
  const uninstalled = fs.readFileSync(hookPath, "utf8");
  assert.match(uninstalled, /echo user-hook/);
  assert.doesNotMatch(uninstalled, /worktree-fleet managed block/);
});

test("later main SHA that does not contain pending becomes divergence", () => {
  const { repo, state, tmp } = makeTempRepo();
  const wt = path.join(tmp, "wt");
  const initial = run("git", ["rev-parse", "HEAD"], repo).trim();
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  cliRun(["status", "--refresh-current"], wt, state);

  fs.appendFileSync(path.join(repo, "file.txt"), "main-a\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "main-a"], repo, { WORKTREE_FLEET_HOME: state });

  run("git", ["reset", "--hard", initial], repo);
  fs.appendFileSync(path.join(repo, "file.txt"), "main-b\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "main-b"], repo, { WORKTREE_FLEET_HOME: state });

  const output = cliRun(["sync"], wt, state);
  assert.match(output, /main target divergence/);
});

test("stale session writes preserve newer pending targets", async () => {
  const { repo, state } = makeTempRepo();
  cliRun(["status", "--refresh-current"], repo, state);
  const sessionFile = fs.readdirSync(path.join(state, "sessions")).find((entry) => entry.endsWith(".json"));
  assert.ok(sessionFile);
  const sessionPath = path.join(state, "sessions", sessionFile);
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  const staleTarget = {
    event_id: "2026-04-28T00-00-00-000Z-repo-aaaaaaaa",
    repo_id: session.repo_id,
    source: "test",
    ref: "main",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    created_at: "2026-04-28T00:00:00.000Z"
  };
  const newerTarget = {
    event_id: "2026-04-28T00-00-01-000Z-repo-bbbbbbbb",
    repo_id: session.repo_id,
    source: "test",
    ref: "main",
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    created_at: "2026-04-28T00:00:01.000Z"
  };

  await withState(state, async () => {
    const { writeSession, readSession } = await import(path.join(root, "dist/core/session.js"));
    const staleSession = structuredClone(session);
    staleSession.integration.pending = staleTarget;
    writeSession(staleSession);

    const sidecarSession = readSession(session.session_id);
    assert.ok(sidecarSession);
    sidecarSession.integration.pending = newerTarget;
    writeSession(sidecarSession);

    staleSession.integration.blocked = true;
    staleSession.integration.blocked_reason = "dirty overlap";
    staleSession.integration.blocked_files = ["file.txt"];
    writeSession(staleSession);

    const finalSession = readSession(session.session_id);
    assert.ok(finalSession);
    const preserved = [
      finalSession.integration.pending,
      ...finalSession.integration.divergent_targets
    ].filter(Boolean).map((target) => target.sha);
    assert.ok(preserved.includes(newerTarget.sha));
  });
});

test("ending a session removes matching intent state", async () => {
  const { repo, state } = makeTempRepo();
  cliRun(["status", "--refresh-current"], repo, state);
  const sessionFile = fs.readdirSync(path.join(state, "sessions")).find((entry) => entry.endsWith(".json"));
  assert.ok(sessionFile);
  const sessionPath = path.join(state, "sessions", sessionFile);
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  const intentPath = path.join(state, "intents", sessionFile);
  assert.ok(fs.existsSync(intentPath));

  await withState(state, async () => {
    const { markSessionEnded } = await import(path.join(root, "dist/core/session.js"));
    markSessionEnded(session);
  });

  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(fs.existsSync(intentPath), false);
});

test("fleet command reports usage when no subcommand is supplied", () => {
  const result = spawnSync("node", [path.join(root, "dist/cli/fleet.js")], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: fleet codex/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRepoConfig(state) {
  const reposDir = path.join(state, "repos");
  const repoId = fs.readdirSync(reposDir)[0];
  assert.ok(repoId);
  return path.join(reposDir, repoId, "config.json");
}

async function withState(state, fn) {
  const previous = process.env.WORKTREE_FLEET_HOME;
  process.env.WORKTREE_FLEET_HOME = state;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WORKTREE_FLEET_HOME;
    else process.env.WORKTREE_FLEET_HOME = previous;
  }
}
