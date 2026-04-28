import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RepoInfo } from "../core/types.js";
import { git, gitOrThrow } from "./command.js";

export function getRepoRoot(cwd: string): string {
  return gitOrThrow(cwd, ["rev-parse", "--show-toplevel"]);
}

export function getCommonDir(cwd: string): string {
  const raw = gitOrThrow(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return fs.realpathSync.native(path.resolve(cwd, raw));
}

export function getGitDir(cwd: string): string {
  const raw = gitOrThrow(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  return fs.realpathSync.native(path.resolve(cwd, raw));
}

export function getRepoId(cwd: string): string {
  return crypto.createHash("sha256").update(getCommonDir(cwd)).digest("hex");
}

export function getBranch(cwd: string): string {
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.ok && branch.stdout) return branch.stdout;
  return "HEAD";
}

export function getHeadSha(cwd: string): string {
  return gitOrThrow(cwd, ["rev-parse", "HEAD"]);
}

export function getRepoInfo(cwd: string): RepoInfo {
  const root = getRepoRoot(cwd);
  return {
    root,
    commonDir: getCommonDir(root),
    repoId: getRepoId(root),
    branch: getBranch(root),
    head: getHeadSha(root)
  };
}

export function hasRemote(cwd: string, remote = "origin"): boolean {
  return git(cwd, ["remote", "get-url", remote]).ok;
}
