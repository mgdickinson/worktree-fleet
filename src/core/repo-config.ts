import { CURRENT_SCHEMA_VERSION, RepoConfigState } from "./types.js";
import { repoConfigPath, repoDir } from "./paths.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./fs.js";
import { nowIso } from "./time.js";
import { git } from "../git/command.js";
import { getRepoInfo } from "../git/repo.js";

export function ensureRepoConfig(cwd: string): RepoConfigState {
  const repo = getRepoInfo(cwd);
  ensureDir(repoDir(repo.repoId));
  const existing = readJsonFile<RepoConfigState>(repoConfigPath(repo.repoId));
  if (existing) return existing;

  const now = nowIso();
  const integrationBranch = detectIntegrationBranch(cwd);
  const config: RepoConfigState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    repo_id: repo.repoId,
    integration_branch: integrationBranch,
    integration_remote: "origin",
    integration_remote_ref: `origin/${integrationBranch}`,
    created_at: now,
    updated_at: now
  };
  atomicWriteJson(repoConfigPath(repo.repoId), config);
  return config;
}

export function readRepoConfig(cwd: string): RepoConfigState {
  const repo = getRepoInfo(cwd);
  return readJsonFile<RepoConfigState>(repoConfigPath(repo.repoId)) ?? ensureRepoConfig(cwd);
}

function detectIntegrationBranch(cwd: string): string {
  const originHead = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.ok && originHead.stdout.includes("/")) {
    return originHead.stdout.slice(originHead.stdout.indexOf("/") + 1);
  }

  const current = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.ok && current.stdout && current.stdout !== "HEAD") return current.stdout;

  return "main";
}
