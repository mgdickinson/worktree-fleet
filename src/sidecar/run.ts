import { setTimeout as delay } from "node:timers/promises";
import { readJsonFile } from "../core/fs.js";
import { writeMainEvent } from "../core/events.js";
import { lastFetchPath } from "../core/paths.js";
import { heartbeat, readSession, refreshSessionDirty, writeSession } from "../core/session.js";
import { absorbRepoEvents } from "../core/integration.js";
import { LastFetchState, SessionState } from "../core/types.js";
import { fetchWithLease } from "../git/fetch.js";
import { readRepoConfig } from "../core/repo-config.js";
import { logActivity } from "../core/activity.js";

const DEFAULT_SIDECAR_TICK_MS = 10_000;

export interface SidecarController {
  stop(): void;
  done: Promise<void>;
}

export function startSidecar(session: SessionState): SidecarController {
  let stopped = false;
  let stopReason = "stop requested";
  let current = session;
  const abort = new AbortController();
  const tickMs = Number(process.env.WORKTREE_FLEET_TICK_MS ?? DEFAULT_SIDECAR_TICK_MS);

  const done = (async () => {
    logSidecarActivity(current, "sidecar-started", `sidecar started for ${current.agent_kind}`);
    try {
      while (!stopped) {
        const latest = readSession(current.session_id);
        if (!latest) {
          stopReason = "session missing";
          return;
        }
        current = latest;
        try {
          current = heartbeat(current);
          current = absorbRepoEvents(current);
          current = refreshSessionDirty(current);
          runFetchTick(current);
        } catch (error) {
          logSidecarActivity(current, "sidecar-error", sidecarErrorSummary(error), {
            error: serializeError(error)
          });
          // Sidecar should never kill the wrapped agent.
        }
        try {
          await delay(tickMs, undefined, { signal: abort.signal });
        } catch (error) {
          if (abort.signal.aborted) return;
          stopReason = "delay failed";
          logSidecarActivity(current, "sidecar-error", sidecarErrorSummary(error), {
            error: serializeError(error)
          });
          return;
        }
      }
    } finally {
      logSidecarActivity(current, "sidecar-stopped", `sidecar stopped: ${stopReason}`, {
        reason: stopReason
      });
    }
  })();

  return {
    stop() {
      stopped = true;
      abort.abort();
    },
    done
  };
}

function logSidecarActivity(
  session: SessionState,
  kind: "sidecar-started" | "sidecar-error" | "sidecar-stopped",
  summary: string,
  details: Record<string, unknown> = {}
): void {
  try {
    logActivity({
      kind,
      summary,
      repoId: session.repo_id,
      sessionId: session.session_id,
      worktreePath: session.worktree_path,
      details: {
        agent_kind: session.agent_kind,
        branch: session.branch,
        ...details
      }
    });
  } catch {
    // Logging must never become the reason a sidecar disrupts an agent.
  }
}

function sidecarErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `sidecar tick failed: ${message}`;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: String(error)
  };
}

function runFetchTick(session: SessionState): void {
  const before = readJsonFile<LastFetchState>(lastFetchPath(session.repo_id));
  const repoConfig = readRepoConfig(session.worktree_path);
  const result = fetchWithLease(session.worktree_path, session.repo_id);
  if (!result.fetched) return;
  const after = readJsonFile<LastFetchState>(lastFetchPath(session.repo_id));
  if (!after?.last_observed_sha || before?.last_observed_sha === after.last_observed_sha) return;
  const event = writeMainEvent({
    repo_id: session.repo_id,
    source: "remote-main",
    ref: repoConfig.integration_remote_ref,
    sha: after.last_observed_sha
  });
  logActivity({
    kind: "main-event",
    summary: `remote ${repoConfig.integration_remote_ref} advanced to ${after.last_observed_sha.slice(0, 12)}`,
    repoId: session.repo_id,
    sessionId: session.session_id,
    worktreePath: session.worktree_path,
    details: {
      event_id: event.event_id,
      source: event.source,
      ref: event.ref,
      sha: event.sha
    }
  });
  const latest = readSession(session.session_id);
  if (latest) {
    latest.integration.pending = latest.integration.pending ?? event;
    writeSession(latest);
  }
}
