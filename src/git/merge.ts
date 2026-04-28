import { spawnSync } from "node:child_process";
import { git } from "./command.js";

export interface MergeResult {
  ok: boolean;
  stderr: string;
  conflictedFiles: string[];
}

export function mergeTarget(cwd: string, target: string): MergeResult {
  const result = spawnSync("git", ["merge", "--no-edit", target], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const conflicts = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return {
    ok: result.status === 0,
    stderr: (result.stderr || result.stdout || "").trim(),
    conflictedFiles: conflicts.ok ? conflicts.stdout.split("\n").filter(Boolean).sort() : []
  };
}
