import fs from "node:fs";
import path from "node:path";
import { ensureStateRoot } from "../core/init.js";
import { lastMainEventPath, repoDir, stateRoot } from "../core/paths.js";
import { ensureDir } from "../core/fs.js";
import { writeMainEvent } from "../core/events.js";
import { getRepoInfo } from "../git/repo.js";
import { readRepoConfig } from "../core/repo-config.js";
import { logActivity } from "../core/activity.js";

export function mainAdvanced(cwd: string): string {
  ensureStateRoot();
  const repo = getRepoInfo(cwd);
  const config = readRepoConfig(repo.root);
  if (repo.branch !== config.integration_branch) return `not on ${config.integration_branch}; no event`;
  ensureDir(repoDir(repo.repoId));
  const lastPath = lastMainEventPath(repo.repoId);
  const last = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, "utf8").trim() : null;
  if (last === repo.head) return "main event already emitted";
  const event = writeMainEvent({
    repo_id: repo.repoId,
    source: "local-main",
    ref: config.integration_branch,
    sha: repo.head
  });
  fs.writeFileSync(lastPath, `${repo.head}\n`);
  logActivity({
    kind: "main-event",
    summary: `local ${config.integration_branch} advanced to ${repo.head.slice(0, 12)}`,
    repoId: repo.repoId,
    sessionId: null,
    worktreePath: repo.root,
    details: {
      event_id: event.event_id,
      source: event.source,
      ref: event.ref,
      sha: event.sha
    }
  });
  return `wrote ${event.event_id}`;
}

export function logHookFailure(kind: string, cwd: string, status: string): string {
  ensureStateRoot();
  const dir = path.join(stateRoot(), "hook-failures");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${process.pid}.log`);
  fs.writeFileSync(file, `${new Date().toISOString()} ${kind} ${cwd} ${status}\n`);
  return file;
}
