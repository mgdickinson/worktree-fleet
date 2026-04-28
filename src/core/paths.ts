import { homedir } from "node:os";
import path from "node:path";

export function stateRoot(): string {
  return process.env.WORKTREE_FLEET_HOME ?? path.join(homedir(), ".worktree-fleet");
}

export function configPath(): string {
  return path.join(stateRoot(), "config.json");
}

export function sessionsDir(): string {
  return path.join(stateRoot(), "sessions");
}

export function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function sessionLockPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.lock`);
}

export function intentsDir(): string {
  return path.join(stateRoot(), "intents");
}

export function adaptersDir(): string {
  return path.join(stateRoot(), "adapters");
}

export function activityDir(): string {
  return path.join(stateRoot(), "activity");
}

export function adapterPath(kind: string): string {
  return path.join(adaptersDir(), `${kind}.json`);
}

export function intentPath(sessionId: string): string {
  return path.join(intentsDir(), `${sessionId}.json`);
}

export function reposDir(): string {
  return path.join(stateRoot(), "repos");
}

export function repoDir(repoId: string): string {
  return path.join(reposDir(), repoId);
}

export function repoConfigPath(repoId: string): string {
  return path.join(repoDir(repoId), "config.json");
}

export function fetchLockPath(repoId: string): string {
  return path.join(repoDir(repoId), "fetch.lock");
}

export function lastFetchPath(repoId: string): string {
  return path.join(repoDir(repoId), "last-fetch.json");
}

export function lastMainEventPath(repoId: string): string {
  return path.join(repoDir(repoId), "last-main-event");
}

export function mainEventsDir(): string {
  return path.join(stateRoot(), "bus", "main-events");
}
