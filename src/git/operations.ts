import fs from "node:fs";
import path from "node:path";
import { getCommonDir, getGitDir } from "./repo.js";

export function getActiveOperation(cwd: string): string | null {
  const commonDir = getCommonDir(cwd);
  const gitDir = getGitDir(cwd);
  const dirs = Array.from(new Set([gitDir, commonDir]));
  const checks: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"]
  ];

  for (const [entry, operation] of checks) {
    if (dirs.some((dir) => fs.existsSync(path.join(dir, entry)))) return operation;
  }
  return null;
}
