import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SCHEMA_VERSION, IntentState, PendingTarget, SessionState } from "./types.js";
import { intentPath, intentsDir, sessionLockPath, sessionPath, sessionsDir } from "./paths.js";
import { atomicWriteJson, listJsonFiles, readJsonFile } from "./fs.js";
import { nowIso } from "./time.js";
import { getDirtyFiles } from "../git/dirty.js";
import { getHeadSha, getRepoInfo } from "../git/repo.js";
import { git } from "../git/command.js";
import { contains, objectExists } from "../git/ancestry.js";
import { acquireFileLock, releaseFileLock } from "./locks.js";
import { applyEventToSession, normalizePendingTargets } from "./pending-targets.js";
import { readRepoConfig } from "./repo-config.js";
import { logActivity } from "./activity.js";

export const ADAPTER_VERSION = "0.1.0";
const SESSION_LOCK_TTL_MS = 30 * 1000;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

export function defaultIntegration(): SessionState["integration"] {
  return {
    pending: null,
    blocked: false,
    blocked_event_id: null,
    blocked_files: [],
    blocked_reason: null,
    divergent_targets: [],
    last_notified_block_key: null,
    last_integrated_sha: null
  };
}

export function createSession(cwd: string, agentKind: string): SessionState {
  const repo = getRepoInfo(cwd);
  const now = nowIso();
  const dirtyFiles = getDirtyFiles(repo.root);
  const session: SessionState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    session_id: randomUUID(),
    agent_kind: agentKind,
    adapter: "worktree-fleet-cli",
    adapter_version: ADAPTER_VERSION,
    pid: process.pid,
    worktree_path: repo.root,
    repo_id: repo.repoId,
    branch: repo.branch,
    started_at: now,
    heartbeat_at: now,
    dirty_files: dirtyFiles,
    dirty_refreshed_at: now,
    last_absorbed_event_id: null,
    integration: {
      ...defaultIntegration(),
      last_integrated_sha: repo.head
    }
  };
  const seeded = seedInitialPending(session);
  writeSession(seeded);
  ensureIntent(session.session_id);
  logActivity({
    kind: "session-started",
    summary: `${agentKind} session started on ${repo.branch}`,
    repoId: repo.repoId,
    sessionId: session.session_id,
    worktreePath: repo.root,
    details: {
      agent_kind: agentKind,
      branch: repo.branch,
      dirty_files: dirtyFiles
    }
  });
  return seeded;
}

export function writeSession(session: SessionState): void {
  withSessionLock(session.session_id, () => {
    const latest = readJsonFile<SessionState>(sessionPath(session.session_id));
    atomicWriteJson(sessionPath(session.session_id), latest ? mergeSessionForWrite(latest, session) : session);
  });
}

export function readSession(sessionId: string): SessionState | null {
  return readJsonFile<SessionState>(sessionPath(sessionId));
}

export function listSessions(): SessionState[] {
  return listJsonFiles(sessionsDir())
    .map((file) => readJsonFile<SessionState>(file))
    .filter((session): session is SessionState => Boolean(session));
}

export function findSessionForWorktree(cwd: string): SessionState | null {
  const repo = getRepoInfo(cwd);
  const root = fs.realpathSync.native(repo.root);
  const matches = listSessions()
    .filter((session) => session.repo_id === repo.repoId)
    .filter((session) => {
      try {
        return fs.realpathSync.native(session.worktree_path) === root;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.heartbeat_at.localeCompare(a.heartbeat_at));
  return matches[0] ?? null;
}

export function ensureSession(cwd: string, agentKind = "generic-cli"): SessionState {
  return findSessionForWorktree(cwd) ?? createSession(cwd, agentKind);
}

export function refreshSessionDirty(session: SessionState): SessionState {
  const now = nowIso();
  const repo = getRepoInfo(session.worktree_path);
  const refreshed: SessionState = {
    ...session,
    branch: repo.branch,
    dirty_files: getDirtyFiles(repo.root),
    dirty_refreshed_at: now,
    heartbeat_at: now
  };
  writeSession(refreshed);
  return refreshed;
}

export function heartbeat(session: SessionState): SessionState {
  const updated = {
    ...session,
    heartbeat_at: nowIso()
  };
  writeSession(updated);
  return updated;
}

export function markSessionEnded(session: SessionState): void {
  logActivity({
    kind: "session-ended",
    summary: `${session.agent_kind} session ended on ${session.branch}`,
    repoId: session.repo_id,
    sessionId: session.session_id,
    worktreePath: session.worktree_path,
    details: {
      agent_kind: session.agent_kind,
      branch: session.branch
    }
  });
  try {
    fs.unlinkSync(sessionPath(session.session_id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    fs.unlinkSync(intentPath(session.session_id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function ensureIntent(sessionId: string): IntentState {
  const existing = readJsonFile<IntentState>(intentPath(sessionId));
  if (existing) return existing;
  const intent: IntentState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    session_id: sessionId,
    tool_touched: [],
    upcoming: [],
    updated_at: nowIso()
  };
  atomicWriteJson(intentPath(sessionId), intent);
  return intent;
}

export function listIntents(): IntentState[] {
  return listJsonFiles(intentsDir())
    .map((file) => readJsonFile<IntentState>(file))
    .filter((intent): intent is IntentState => Boolean(intent));
}

export function updateIntent(sessionId: string, updater: (intent: IntentState) => IntentState): IntentState {
  const next = updater(ensureIntent(sessionId));
  atomicWriteJson(intentPath(sessionId), next);
  return next;
}

export function sweepStaleSessions(staleMs = 5 * 60 * 1000): number {
  let swept = 0;
  for (const session of listSessions()) {
    const heartbeatAge = Date.now() - Date.parse(session.heartbeat_at);
    const staleHeartbeat = Number.isNaN(heartbeatAge) || heartbeatAge > staleMs;
    let pidDead = false;
    try {
      process.kill(session.pid, 0);
    } catch {
      pidDead = true;
    }

    if (pidDead || staleHeartbeat) {
      try {
        fs.unlinkSync(sessionPath(session.session_id));
      } catch {
        // Best-effort sweep; a concurrent writer may already have replaced it.
      }
      try {
        fs.unlinkSync(path.join(intentsDir(), `${session.session_id}.json`));
      } catch {
        // Same best-effort cleanup as the session file.
      }
      swept += 1;
    }
  }
  return swept;
}

function seedInitialPending(session: SessionState): SessionState {
  const repoConfig = readRepoConfig(session.worktree_path);
  const candidates = [repoConfig.integration_branch, repoConfig.integration_remote_ref];
  let next = session;
  for (const ref of candidates) {
    const resolved = git(session.worktree_path, ["rev-parse", "--verify", ref]);
    if (!resolved.ok || !resolved.stdout) continue;
    if (!objectExists(session.worktree_path, resolved.stdout)) continue;
    if (contains(session.worktree_path, session.integration.last_integrated_sha ?? "", resolved.stdout)) continue;
    const event = {
      event_id: `${nowIso().replace(/:/g, "-")}-${session.repo_id}-${resolved.stdout}-${ref.replace("/", "-")}`,
      repo_id: session.repo_id,
      source: "session-start-catchup",
      ref,
      sha: resolved.stdout,
      created_at: nowIso()
    };
    next = applyEventToSession(session.worktree_path, next, event);
  }
  return next;
}

function withSessionLock<T>(sessionId: string, fn: () => T): T {
  const lockPath = sessionLockPath(sessionId);
  const deadline = Date.now() + 5000;
  while (!acquireFileLock(lockPath, { ttlMs: SESSION_LOCK_TTL_MS })) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for session lock: ${sessionId}`);
    }
    sleepSync(25);
  }

  try {
    return fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function mergeSessionForWrite(latest: SessionState, proposed: SessionState): SessionState {
  const merged = structuredClone(proposed) as SessionState;
  const beforePending = proposed.integration.pending?.event_id ?? null;
  const beforeDivergent = new Set(proposed.integration.divergent_targets.map((target) => target.event_id));
  const candidates = uniqueTargets([
    proposed.integration.pending,
    ...proposed.integration.divergent_targets,
    latest.integration.pending,
    ...latest.integration.divergent_targets
  ]).filter((target) => !isIntegrated(proposed.worktree_path, target));

  merged.integration.pending = proposed.integration.pending && candidates.some((target) => target.event_id === proposed.integration.pending?.event_id)
    ? proposed.integration.pending
    : candidates[0] ?? null;
  merged.integration.divergent_targets = candidates.filter((target) => target.event_id !== merged.integration.pending?.event_id);

  const normalized = tryNormalize(proposed.worktree_path, merged);
  const afterPending = normalized.integration.pending?.event_id ?? null;
  const divergentChanged = normalized.integration.divergent_targets.some((target) => !beforeDivergent.has(target.event_id))
    || beforeDivergent.size !== normalized.integration.divergent_targets.length;

  if (afterPending !== beforePending || divergentChanged) {
    normalized.integration.blocked = false;
    normalized.integration.blocked_event_id = null;
    normalized.integration.blocked_files = [];
    normalized.integration.blocked_reason = null;
  }

  if (normalized.integration.divergent_targets.length > 0) {
    normalized.integration.blocked = true;
    normalized.integration.blocked_event_id = normalized.integration.pending?.event_id ?? null;
    normalized.integration.blocked_reason = "main target divergence";
    normalized.integration.blocked_files = normalized.integration.divergent_targets.map((target) => target.sha);
  }

  if (!normalized.integration.last_integrated_sha && latest.integration.last_integrated_sha) {
    normalized.integration.last_integrated_sha = latest.integration.last_integrated_sha;
  }
  normalized.last_absorbed_event_id = maxEventId(latest.last_absorbed_event_id, proposed.last_absorbed_event_id);

  return normalized;
}

function tryNormalize(cwd: string, session: SessionState): SessionState {
  try {
    return normalizePendingTargets(cwd, session).session;
  } catch {
    return session;
  }
}

function uniqueTargets(targets: Array<PendingTarget | null | undefined>): PendingTarget[] {
  const seen = new Set<string>();
  const result: PendingTarget[] = [];
  for (const target of targets) {
    if (!target || seen.has(target.event_id)) continue;
    seen.add(target.event_id);
    result.push(target);
  }
  return result;
}

function isIntegrated(cwd: string, target: PendingTarget): boolean {
  try {
    const head = getHeadSha(cwd);
    return objectExists(cwd, target.sha) && contains(cwd, head, target.sha);
  } catch {
    return false;
  }
}

function maxEventId(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}
