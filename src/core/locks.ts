import fs from "node:fs";
import os from "node:os";
import { LockMetadata } from "./types.js";
import { ageMs, nowIso } from "./time.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./fs.js";
import path from "node:path";

export interface LockOptions {
  ttlMs: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireFileLock(file: string, options: LockOptions): boolean {
  ensureDir(path.dirname(file));
  const metadata: LockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: nowIso()
  };

  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(metadata, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = readJsonFile<LockMetadata>(file);
  const expired = !existing || ageMs(existing.acquired_at) > options.ttlMs;
  const sameHost = existing?.hostname === os.hostname();
  const ownerDead = existing ? sameHost && !pidAlive(existing.pid) : true;
  if (!expired || (sameHost && !ownerDead)) return false;

  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return acquireFileLock(file, options);
}

export function releaseFileLock(file: string): void {
  const existing = readJsonFile<LockMetadata>(file);
  if (existing?.pid !== process.pid || existing.hostname !== os.hostname()) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
