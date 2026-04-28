import { fetchWithLease } from "../git/fetch.js";
import { getIncomingFiles, getStagedFiles } from "../git/dirty.js";
import { mergeTarget } from "../git/merge.js";
import { getActiveOperation } from "../git/operations.js";
import { getHeadSha, getRepoInfo } from "../git/repo.js";
import { objectExists } from "../git/ancestry.js";
import { listMainEvents, toPendingTarget } from "./events.js";
import { applyEventToSession, normalizePendingTargets } from "./pending-targets.js";
import { refreshSessionDirty, readSession, writeSession } from "./session.js";
import { SessionState } from "./types.js";
import { logActivity } from "./activity.js";

export interface SyncResult {
  status: "noop" | "merged" | "blocked" | "error";
  message: string;
  session: SessionState;
}

export function absorbRepoEvents(session: SessionState): SessionState {
  const repo = getRepoInfo(session.worktree_path);
  let next = session;
  for (const event of listMainEvents(repo.repoId)) {
    if (next.last_absorbed_event_id && event.event_id <= next.last_absorbed_event_id) continue;
    next = applyEventToSession(repo.root, next, toPendingTarget(event));
    next.last_absorbed_event_id = event.event_id;
  }
  writeSession(next);
  return next;
}

function block(session: SessionState, reason: string, files: string[] = []): SessionState {
  const pendingEventId = session.integration.pending?.event_id ?? null;
  const next = structuredClone(session) as SessionState;
  if ((next.integration.pending?.event_id ?? null) !== pendingEventId) return next;
  next.integration.blocked = true;
  next.integration.blocked_event_id = next.integration.pending?.event_id ?? null;
  next.integration.blocked_reason = reason;
  next.integration.blocked_files = files;
  writeSession(next);
  return next;
}

function clearIntegrated(session: SessionState, target: string, pendingEventId: string): SessionState {
  const latest = readSession(session.session_id) ?? session;
  const next = structuredClone(latest) as SessionState;
  if (latest.integration.pending?.event_id === pendingEventId) {
    next.integration.pending = null;
    next.integration.divergent_targets = [];
    next.integration.blocked = false;
    next.integration.blocked_event_id = null;
    next.integration.blocked_files = [];
    next.integration.blocked_reason = null;
    next.integration.last_integrated_sha = target;
  }
  writeSession(next);
  return next;
}

export function syncSession(session: SessionState): SyncResult {
  const repo = getRepoInfo(session.worktree_path);
  let current = refreshSessionDirty(absorbRepoEvents(session));

  if (!current.integration.pending) {
    logSyncActivity(current, "sync-noop", "no pending main target");
    return { status: "noop", message: "no pending main target", session: current };
  }

  const operation = getActiveOperation(repo.root);
  if (operation) {
    current = block(current, `git operation in progress: ${operation}`);
    logSyncActivity(current, "sync-blocked", current.integration.blocked_reason ?? "git operation in progress");
    return { status: "blocked", message: current.integration.blocked_reason ?? "blocked", session: current };
  }

  let normalized = normalizePendingTargets(repo.root, current);
  current = normalized.session;
  writeSession(current);
  if (!current.integration.pending) {
    logSyncActivity(current, "sync-noop", "pending target already integrated");
    return { status: "noop", message: "pending target already integrated", session: current };
  }

  const candidates = [current.integration.pending, ...current.integration.divergent_targets];
  const missing = candidates.filter((candidate) => !objectExists(repo.root, candidate.sha));
  if (missing.length > 0) {
    fetchWithLease(repo.root, repo.repoId, true);
    normalized = normalizePendingTargets(repo.root, current);
    current = normalized.session;
    writeSession(current);
  }

  if (!current.integration.pending) {
    logSyncActivity(current, "sync-noop", "pending target already integrated after fetch");
    return { status: "noop", message: "pending target already integrated after fetch", session: current };
  }

  if (current.integration.divergent_targets.length > 0) {
    current = block(current, "main target divergence", current.integration.divergent_targets.map((target) => target.sha));
    logSyncActivity(current, "sync-blocked", "main target divergence");
    return { status: "blocked", message: "main target divergence", session: current };
  }

  const pendingEventId = current.integration.pending.event_id;
  const target = current.integration.pending.sha;
  if (!objectExists(repo.root, target)) {
    current = block(current, "target object unavailable");
    logSyncActivity(current, "sync-blocked", "target object unavailable");
    return { status: "blocked", message: "target object unavailable", session: current };
  }

  const staged = getStagedFiles(repo.root);
  if (staged.length > 0) {
    current = block(current, "index has staged changes; integration requires a clean index", staged);
    logSyncActivity(current, "sync-blocked", current.integration.blocked_reason ?? "index has staged changes");
    return { status: "blocked", message: current.integration.blocked_reason ?? "blocked", session: current };
  }

  const incoming = getIncomingFiles(repo.root, target);
  const dirtyOverlap = current.dirty_files.filter((file) => incoming.includes(file));
  if (dirtyOverlap.length > 0) {
    current = block(current, "dirty overlap", dirtyOverlap);
    logSyncActivity(current, "sync-blocked", "dirty overlap");
    return { status: "blocked", message: "dirty overlap", session: current };
  }

  const merge = mergeTarget(repo.root, target);
  if (!merge.ok) {
    current = block(current, merge.stderr || "git merge failed", merge.conflictedFiles);
    logSyncActivity(current, "sync-error", current.integration.blocked_reason ?? "git merge failed");
    return { status: "error", message: current.integration.blocked_reason ?? "git merge failed", session: current };
  }

  const afterHead = getHeadSha(repo.root);
  current = clearIntegrated(current, target, pendingEventId);
  current = refreshSessionDirty(current);
  logSyncActivity(current, "sync-merged", `merged ${target.slice(0, 12)}`);
  return {
    status: "merged",
    message: `merged ${target.slice(0, 12)} at ${afterHead.slice(0, 12)}`,
    session: current
  };
}

function logSyncActivity(session: SessionState, kind: string, summary: string): void {
  logActivity({
    kind,
    summary,
    repoId: session.repo_id,
    sessionId: session.session_id,
    worktreePath: session.worktree_path,
    details: {
      branch: session.branch,
      pending: session.integration.pending,
      divergent_targets: session.integration.divergent_targets,
      blocked: session.integration.blocked,
      blocked_reason: session.integration.blocked_reason,
      blocked_files: session.integration.blocked_files
    }
  });
}
