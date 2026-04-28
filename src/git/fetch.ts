import { CURRENT_SCHEMA_VERSION, LastFetchState } from "../core/types.js";
import { fetchLockPath, lastFetchPath } from "../core/paths.js";
import { acquireFileLock, releaseFileLock } from "../core/locks.js";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { ageMs, nowIso } from "../core/time.js";
import { git } from "./command.js";
import { hasRemote } from "./repo.js";
import { readRepoConfig } from "../core/repo-config.js";

export interface FetchLeaseResult {
  fetched: boolean;
  skipped: boolean;
  error: string | null;
}

const DEFAULT_FETCH_INTERVAL_MS = 30 * 1000;
const LOCK_TTL_MS = 60 * 1000;

export function fetchWithLease(cwd: string, repoId: string, force = false): FetchLeaseResult {
  const repoConfig = readRepoConfig(cwd);
  if (!hasRemote(cwd, repoConfig.integration_remote)) {
    return { fetched: false, skipped: true, error: `${repoConfig.integration_remote} remote not configured` };
  }

  const lock = fetchLockPath(repoId);
  if (!acquireFileLock(lock, { ttlMs: LOCK_TTL_MS })) {
    return { fetched: false, skipped: true, error: null };
  }

  try {
    const previous = readJsonFile<LastFetchState>(lastFetchPath(repoId));
    if (!force && previous?.last_fetch_attempt_at && ageMs(previous.last_fetch_attempt_at) < fetchIntervalMs()) {
      return { fetched: false, skipped: true, error: null };
    }

    const attemptAt = nowIso();
    const attempted: LastFetchState = {
      schema_version: CURRENT_SCHEMA_VERSION,
      repo_id: repoId,
      remote: repoConfig.integration_remote,
      ref: `refs/remotes/${repoConfig.integration_remote}/${repoConfig.integration_branch}`,
      last_fetch_attempt_at: attemptAt,
      last_fetch_success_at: previous?.last_fetch_success_at ?? null,
      last_observed_sha: previous?.last_observed_sha ?? null,
      last_error: null
    };
    atomicWriteJson(lastFetchPath(repoId), attempted);

    const fetch = git(cwd, ["fetch", "--no-write-fetch-head", repoConfig.integration_remote]);
    if (!fetch.ok) {
      atomicWriteJson(lastFetchPath(repoId), {
        ...attempted,
        last_error: fetch.stderr || `git fetch exited ${fetch.status}`
      } satisfies LastFetchState);
      return { fetched: false, skipped: false, error: fetch.stderr };
    }

    const observed = git(cwd, ["rev-parse", "--verify", repoConfig.integration_remote_ref]);
    atomicWriteJson(lastFetchPath(repoId), {
      ...attempted,
      last_fetch_success_at: nowIso(),
      last_observed_sha: observed.ok ? observed.stdout : attempted.last_observed_sha,
      last_error: null
    } satisfies LastFetchState);
    return { fetched: true, skipped: false, error: null };
  } finally {
    releaseFileLock(lock);
  }
}

function fetchIntervalMs(): number {
  const configured = Number(process.env.WORKTREE_FLEET_FETCH_INTERVAL_MS ?? DEFAULT_FETCH_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_FETCH_INTERVAL_MS;
}
