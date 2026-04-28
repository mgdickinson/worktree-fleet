import fs from "node:fs";
import { adapterPath, adaptersDir } from "./paths.js";
import { atomicWriteJson, ensureDir, listJsonFiles, readJsonFile } from "./fs.js";
import { nowIso } from "./time.js";
import { AdapterMode, AdapterRegistration, CURRENT_SCHEMA_VERSION } from "./types.js";

export interface AdapterInstallInput {
  kind: string;
  mode?: AdapterMode;
  packageBin?: string | null;
  command?: string | null;
  nativeLifecycle?: boolean;
  notes?: string[];
}

export function registerAdapter(input: AdapterInstallInput): AdapterRegistration {
  ensureDir(adaptersDir());
  const kind = normalizeAdapterKind(input.kind);
  const existing = readJsonFile<AdapterRegistration>(adapterPath(kind));
  const now = nowIso();
  const registration: AdapterRegistration = {
    schema_version: CURRENT_SCHEMA_VERSION,
    kind,
    mode: input.mode ?? defaultMode(kind),
    installed_at: existing?.installed_at ?? now,
    updated_at: now,
    package_bin: input.packageBin ?? existing?.package_bin ?? null,
    command: input.command ?? existing?.command ?? defaultCommand(kind),
    native_lifecycle: input.nativeLifecycle ?? existing?.native_lifecycle ?? defaultNativeLifecycle(kind),
    notes: input.notes ?? existing?.notes ?? defaultNotes(kind)
  };
  atomicWriteJson(adapterPath(kind), registration);
  return registration;
}

export function unregisterAdapter(kind: string): boolean {
  const file = adapterPath(normalizeAdapterKind(kind));
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function readAdapter(kind: string): AdapterRegistration | null {
  return readJsonFile<AdapterRegistration>(adapterPath(normalizeAdapterKind(kind)));
}

export function listAdapters(): AdapterRegistration[] {
  return listJsonFiles(adaptersDir())
    .map((file) => readJsonFile<AdapterRegistration>(file))
    .filter((adapter): adapter is AdapterRegistration => Boolean(adapter))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

export function normalizeAdapterKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function defaultMode(kind: string): AdapterMode {
  if (kind === "codex") return "wrapper";
  if (kind === "claude") return "host-managed";
  return "generic";
}

function defaultCommand(kind: string): string | null {
  if (kind === "codex") return "fleet codex";
  if (kind === "claude") return null;
  return `worktree-fleet session start --agent ${kind} -- <command...>`;
}

function defaultNativeLifecycle(kind: string): boolean {
  return kind === "claude";
}

function defaultNotes(kind: string): string[] {
  if (kind === "codex") {
    return [
      "Wrapper mode launches Codex under `fleet codex` and syncs through the sidecar.",
      "Native Codex lifecycle hooks can replace wrapper mode when the host exposes them."
    ];
  }
  if (kind === "claude") {
    return [
      "Claude integration is host-managed; this package records consent and provides the shared fleet core."
    ];
  }
  return [
    "Generic adapter registration records consent; wrap the agent with worktree-fleet session start."
  ];
}
