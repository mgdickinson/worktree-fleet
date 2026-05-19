import { isAncestor } from "../git/ancestry.js";
import { git } from "../git/command.js";
import { getDirtyFiles } from "../git/dirty.js";
import { getActiveOperation } from "../git/operations.js";
import { getHeadSha, getRepoInfo } from "../git/repo.js";
import { mainAdvanced } from "../hooks/main-advanced.js";
import { logActivity } from "./activity.js";
import { syncSession } from "./integration.js";
import { readRepoConfig } from "./repo-config.js";
import { ensureSession, findSessionForWorktree, refreshSessionDirty } from "./session.js";

export interface LandResult {
  status: "landed" | "blocked" | "error";
  message: string;
}

interface GitWorktree {
  path: string;
  branchRef: string | null;
}

export function landCurrentWorktree(cwd: string): LandResult {
  const session = ensureSession(cwd);
  const repo = getRepoInfo(session.worktree_path);
  const config = readRepoConfig(repo.root);
  if (repo.branch === "HEAD") {
    return { status: "blocked", message: "cannot land from detached HEAD" };
  }
  if (repo.branch === config.integration_branch) {
    return { status: "blocked", message: `already on integration branch ${config.integration_branch}` };
  }

  const currentOperation = getActiveOperation(repo.root);
  if (currentOperation) {
    return { status: "blocked", message: `current worktree has git operation in progress: ${currentOperation}` };
  }

  const sync = syncSession(session);
  if (sync.status === "blocked" || sync.status === "error") {
    return { status: "blocked", message: `cannot land until sync is clear: ${sync.message}` };
  }

  const refreshedRepo = getRepoInfo(repo.root);
  const currentDirty = getDirtyFiles(refreshedRepo.root);
  if (currentDirty.length > 0) {
    return { status: "blocked", message: `current worktree has uncommitted changes: ${currentDirty.join(",")}` };
  }

  const integration = findIntegrationWorktree(refreshedRepo.root, config.integration_branch);
  if (!integration) {
    return { status: "blocked", message: `no worktree found for integration branch ${config.integration_branch}` };
  }
  if (integration.path === refreshedRepo.root) {
    return { status: "blocked", message: `already on integration branch ${config.integration_branch}` };
  }

  const integrationOperation = getActiveOperation(integration.path);
  if (integrationOperation) {
    return { status: "blocked", message: `integration worktree has git operation in progress: ${integrationOperation}` };
  }

  const integrationDirty = getDirtyFiles(integration.path);
  if (integrationDirty.length > 0) {
    return { status: "blocked", message: `integration worktree has uncommitted changes: ${integrationDirty.join(",")}` };
  }

  const integrationHead = getHeadSha(integration.path);
  const featureHead = getHeadSha(refreshedRepo.root);
  if (!isAncestor(refreshedRepo.root, integrationHead, featureHead)) {
    return {
      status: "blocked",
      message: `${config.integration_branch} cannot fast-forward to ${refreshedRepo.branch}; sync or merge ${config.integration_branch} into this worktree first`
    };
  }

  const merge = git(integration.path, ["merge", "--ff-only", featureHead]);
  if (!merge.ok) {
    return { status: "error", message: merge.stderr || merge.stdout || "git merge --ff-only failed" };
  }

  const eventMessage = mainAdvanced(integration.path);
  refreshSessionDirty(ensureSession(refreshedRepo.root));
  const integrationSession = findSessionForWorktree(integration.path);
  if (integrationSession) refreshSessionDirty(integrationSession);

  logActivity({
    kind: "landed",
    summary: `landed ${refreshedRepo.branch} onto ${config.integration_branch}`,
    repoId: refreshedRepo.repoId,
    sessionId: session.session_id,
    worktreePath: refreshedRepo.root,
    details: {
      branch: refreshedRepo.branch,
      head: featureHead,
      integration_branch: config.integration_branch,
      integration_worktree: integration.path,
      main_event: eventMessage
    }
  });

  return {
    status: "landed",
    message: `landed ${refreshedRepo.branch} ${featureHead.slice(0, 12)} onto ${config.integration_branch} at ${integration.path}`
  };
}

function findIntegrationWorktree(cwd: string, branch: string): GitWorktree | null {
  return listGitWorktrees(cwd).find((worktree) => worktree.branchRef === `refs/heads/${branch}`) ?? null;
}

function listGitWorktrees(cwd: string): GitWorktree[] {
  const result = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!result.ok) throw new Error(result.stderr || "git worktree list --porcelain failed");
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length), branchRef: null };
    } else if (line.startsWith("branch ") && current) {
      current.branchRef = line.slice("branch ".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}
