import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { activityDir } from "./paths.js";
import { ensureDir } from "./fs.js";
import { nowIso } from "./time.js";
import { ActivityEvent, CURRENT_SCHEMA_VERSION } from "./types.js";

export interface ActivityInput {
  kind: string;
  summary: string;
  repoId?: string | null;
  sessionId?: string | null;
  worktreePath?: string | null;
  details?: Record<string, unknown>;
}

export interface ListActivityOptions {
  repoId?: string | null;
  limit?: number;
}

export function logActivity(input: ActivityInput): ActivityEvent {
  ensureDir(activityDir());
  const createdAt = nowIso();
  const event: ActivityEvent = {
    schema_version: CURRENT_SCHEMA_VERSION,
    activity_id: randomUUID(),
    created_at: createdAt,
    kind: input.kind,
    summary: input.summary,
    repo_id: input.repoId ?? null,
    session_id: input.sessionId ?? null,
    worktree_path: input.worktreePath ?? null,
    details: input.details ?? {}
  };
  fs.appendFileSync(activityPath(createdAt), `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  return event;
}

export function listActivity(options: ListActivityOptions = {}): ActivityEvent[] {
  const limit = options.limit ?? 50;
  const result: ActivityEvent[] = [];
  for (const file of activityFiles().reverse()) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      const event = parseActivity(line);
      if (!event) continue;
      if (options.repoId && event.repo_id !== options.repoId) continue;
      result.push(event);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function activityPath(createdAt: string): string {
  return path.join(activityDir(), `${createdAt.slice(0, 10)}.jsonl`);
}

function activityFiles(): string[] {
  try {
    return fs.readdirSync(activityDir())
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(activityDir(), name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseActivity(line: string): ActivityEvent | null {
  try {
    return JSON.parse(line) as ActivityEvent;
  } catch {
    return null;
  }
}
