import { CURRENT_SCHEMA_VERSION, ConfigState } from "./types.js";
import { activityDir, adaptersDir, configPath, intentsDir, mainEventsDir, reposDir, sessionsDir } from "./paths.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./fs.js";
import { nowIso } from "./time.js";

export function ensureStateRoot(): void {
  ensureDir(sessionsDir());
  ensureDir(intentsDir());
  ensureDir(adaptersDir());
  ensureDir(activityDir());
  ensureDir(reposDir());
  ensureDir(mainEventsDir());

  const existing = readJsonFile<ConfigState>(configPath());
  const now = nowIso();
  if (!existing) {
    atomicWriteJson(configPath(), {
      schema_version: CURRENT_SCHEMA_VERSION,
      created_at: now,
      updated_at: now
    } satisfies ConfigState);
  }
}
