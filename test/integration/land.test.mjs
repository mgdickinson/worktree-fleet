import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist/cli/index.js");

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

function makeTempRepo(branch = "main") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fleet-land-test-"));
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

function cliRun(args, cwd, state) {
  return run("node", [cli, ...args], cwd, { WORKTREE_FLEET_HOME: state });
}

function seedSession(cwd, state, agent = "generic-cli") {
  run("node", [
    "--input-type=module",
    "-e",
    `import { ensureStateRoot } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/core/init.js")).href)}; import { createSession } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/core/session.js")).href)}; ensureStateRoot(); createSession(process.cwd(), ${JSON.stringify(agent)});`
  ], cwd, { WORKTREE_FLEET_HOME: state });
}

// Stand up an integration repo plus a feature worktree that is one commit ahead
// on a path the caller chooses.
function setupFeatureAheadOnFile(featureFile) {
  const { tmp, repo, state } = makeTempRepo();
  cliRun(["setup", "--yes", "--no-adapters"], repo, state);

  const wt = path.join(tmp, "wt");
  run("git", ["worktree", "add", "-q", "-b", "feature", wt, "HEAD"], repo);
  seedSession(repo, state);
  seedSession(wt, state);

  fs.writeFileSync(path.join(wt, featureFile), "feature work\n");
  run("git", ["add", featureFile], wt);
  run("git", ["commit", "-q", "-m", "feature change"], wt, { WORKTREE_FLEET_HOME: state });

  return { tmp, repo, state, wt };
}

test("land proceeds when the integration worktree is dirty only in UNRELATED files", () => {
  const { repo, state, wt } = setupFeatureAheadOnFile("feature.txt");

  // A sibling session is editing docs / scratch files in the integration
  // worktree — untracked and tracked, both unrelated to the landed change.
  fs.writeFileSync(path.join(repo, "design-notes.md"), "draft\n"); // untracked
  fs.appendFileSync(path.join(repo, "file.txt"), "sibling edit\n"); // tracked, dirty, NOT in the land

  const output = cliRun(["land"], wt, state);
  assert.match(output, /landed feature/);

  // main fast-forwarded to include the feature commit.
  assert.match(run("git", ["log", "--oneline", "-1"], repo), /feature change/);
  assert.equal(fs.existsSync(path.join(repo, "feature.txt")), true);

  // The sibling's uncommitted work is untouched.
  assert.equal(fs.readFileSync(path.join(repo, "design-notes.md"), "utf8"), "draft\n");
  assert.match(fs.readFileSync(path.join(repo, "file.txt"), "utf8"), /sibling edit/);
});

test("land blocks when integration dirt OVERLAPS a file the land would update", () => {
  const { repo, state, wt } = setupFeatureAheadOnFile("shared.txt");

  // The integration worktree has an uncommitted edit to the very file the
  // fast-forward would write — a genuine conflict git would refuse.
  fs.writeFileSync(path.join(repo, "shared.txt"), "concurrent integration edit\n");

  const result = spawnSync("node", [cli, "land"], {
    cwd: wt,
    env: { ...process.env, WORKTREE_FLEET_HOME: state },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /uncommitted changes to files this land would update: shared\.txt/);

  // main did NOT advance.
  assert.doesNotMatch(run("git", ["log", "--oneline", "-1"], repo), /feature change/);
});
