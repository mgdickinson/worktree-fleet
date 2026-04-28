import fs from "node:fs";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION, MainEvent, PendingTarget } from "./types.js";
import { mainEventsDir } from "./paths.js";
import { atomicWriteJson, ensureDir, listJsonFiles, readJsonFile } from "./fs.js";
import { eventTimestamp, nowIso } from "./time.js";

export function toPendingTarget(event: MainEvent): PendingTarget {
  return {
    event_id: event.event_id,
    repo_id: event.repo_id,
    source: event.source,
    ref: event.ref,
    sha: event.sha,
    created_at: event.created_at
  };
}

export function writeMainEvent(input: Omit<MainEvent, "schema_version" | "event_id" | "created_at"> & { created_at?: string }): MainEvent {
  ensureDir(mainEventsDir());
  const createdAt = input.created_at ?? nowIso();
  const eventId = `${eventTimestamp(new Date(createdAt))}-${input.repo_id}-${input.sha}`;
  const event: MainEvent = {
    schema_version: CURRENT_SCHEMA_VERSION,
    event_id: eventId,
    repo_id: input.repo_id,
    source: input.source,
    ref: input.ref,
    sha: input.sha,
    created_at: createdAt
  };
  atomicWriteJson(path.join(mainEventsDir(), `${eventId}.json`), event);
  return event;
}

export function listMainEvents(repoId?: string): MainEvent[] {
  return listJsonFiles(mainEventsDir())
    .map((file) => readJsonFile<MainEvent>(file))
    .filter((event): event is MainEvent => Boolean(event))
    .filter((event) => !repoId || event.repo_id === repoId)
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
}

export function pruneMainEvents(olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of listJsonFiles(mainEventsDir())) {
    const event = readJsonFile<MainEvent>(file);
    if (!event) continue;
    const createdAt = Date.parse(event.created_at);
    if (Number.isNaN(createdAt) || createdAt >= cutoff) continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}

export function readLastEventSha(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
