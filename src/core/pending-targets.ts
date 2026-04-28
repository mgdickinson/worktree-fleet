import { PendingTarget, SessionState } from "./types.js";
import { contains, objectExists } from "../git/ancestry.js";
import { getHeadSha } from "../git/repo.js";

function uniqueCandidates(candidates: Array<PendingTarget | null | undefined>): PendingTarget[] {
  const seen = new Set<string>();
  const result: PendingTarget[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.sha)) continue;
    seen.add(candidate.sha);
    result.push(candidate);
  }
  return result;
}

function choosePending(candidates: PendingTarget[], existing: PendingTarget | null): PendingTarget {
  const existingCandidate = existing ? candidates.find((candidate) => candidate.event_id === existing.event_id) : null;
  if (existingCandidate) return existingCandidate;
  return [...candidates].sort((a, b) => a.event_id.localeCompare(b.event_id)).at(-1) ?? candidates[0];
}

export interface NormalizationResult {
  session: SessionState;
  contained: PendingTarget[];
  missing: PendingTarget[];
}

export function normalizePendingTargets(cwd: string, session: SessionState): NormalizationResult {
  const head = getHeadSha(cwd);
  const original = uniqueCandidates([session.integration.pending, ...session.integration.divergent_targets]);
  const contained: PendingTarget[] = [];
  const missing: PendingTarget[] = [];
  let candidates = original.filter((candidate) => {
    if (!objectExists(cwd, candidate.sha)) {
      missing.push(candidate);
      return true;
    }
    if (contains(cwd, head, candidate.sha)) {
      contained.push(candidate);
      return false;
    }
    return true;
  });

  candidates = candidates.filter((candidate) => {
    if (!objectExists(cwd, candidate.sha)) return true;
    return !candidates.some((other) => {
      if (other.sha === candidate.sha || !objectExists(cwd, other.sha)) return false;
      return contains(cwd, other.sha, candidate.sha);
    });
  });

  const next = structuredClone(session) as SessionState;
  if (candidates.length === 0) {
    next.integration.pending = null;
    next.integration.divergent_targets = [];
    next.integration.blocked = false;
    next.integration.blocked_event_id = null;
    next.integration.blocked_files = [];
    next.integration.blocked_reason = null;
    const furthest = chooseFurthestContained(cwd, contained);
    if (furthest) next.integration.last_integrated_sha = furthest.sha;
    return { session: next, contained, missing };
  }

  const pending = choosePending(candidates, session.integration.pending);
  next.integration.pending = pending;
  next.integration.divergent_targets = candidates.filter((candidate) => candidate.event_id !== pending.event_id);
  if (next.integration.divergent_targets.length === 0 && next.integration.blocked_reason === "main target divergence") {
    next.integration.blocked = true;
  }
  return { session: next, contained, missing };
}

function chooseFurthestContained(cwd: string, candidates: PendingTarget[]): PendingTarget | null {
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    const hasDescendant = candidates.some((other) => other.sha !== candidate.sha && contains(cwd, other.sha, candidate.sha));
    if (!hasDescendant) return candidate;
  }
  return candidates[0];
}

export function applyEventToSession(cwd: string, session: SessionState, event: PendingTarget): SessionState {
  const head = getHeadSha(cwd);
  if (objectExists(cwd, event.sha) && contains(cwd, head, event.sha)) return session;

  const beforePending = session.integration.pending?.sha ?? null;
  const withEvent = structuredClone(session) as SessionState;
  withEvent.integration.pending = withEvent.integration.pending ?? event;
  withEvent.integration.divergent_targets = uniqueCandidates([
    ...withEvent.integration.divergent_targets,
    withEvent.integration.pending?.sha === event.sha ? null : event
  ]);

  const normalized = normalizePendingTargets(cwd, withEvent).session;
  const afterPending = normalized.integration.pending?.sha ?? null;
  if (beforePending && afterPending && beforePending !== afterPending && normalized.integration.blocked) {
    normalized.integration.blocked_files = [];
    normalized.integration.blocked_reason = null;
    normalized.integration.blocked_event_id = null;
  }
  if (normalized.integration.divergent_targets.length > 0) {
    normalized.integration.blocked = true;
    normalized.integration.blocked_event_id = normalized.integration.pending?.event_id ?? null;
    normalized.integration.blocked_reason = "main target divergence";
  }
  return normalized;
}
