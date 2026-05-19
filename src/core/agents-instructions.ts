import fs from "node:fs";
import path from "node:path";
import { getRepoInfo } from "../git/repo.js";
import { readRepoConfig } from "./repo-config.js";

const START = "<!-- >>> worktree-fleet codex instructions >>> -->";
const END = "<!-- <<< worktree-fleet codex instructions <<< -->";

export interface AgentsInstructionsResult {
  path: string;
  changed: boolean;
}

export function installCodexAgentsInstructions(cwd: string): AgentsInstructionsResult {
  const repo = getRepoInfo(cwd);
  const config = readRepoConfig(repo.root);
  const file = path.join(repo.root, "AGENTS.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = managedBlock(config.integration_branch);
  const next = replaceManagedBlock(existing, block);
  if (next !== existing) {
    fs.writeFileSync(file, next);
    return { path: file, changed: true };
  }
  return { path: file, changed: false };
}

export function removeCodexAgentsInstructions(cwd: string): AgentsInstructionsResult | null {
  const repo = getRepoInfo(cwd);
  const file = path.join(repo.root, "AGENTS.md");
  if (!fs.existsSync(file)) return null;
  const existing = fs.readFileSync(file, "utf8");
  const pattern = new RegExp(`\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`, "m");
  const next = existing.replace(pattern, existing.startsWith(START) ? "" : "\n").replace(/\n{3,}/g, "\n\n");
  if (next !== existing) {
    if (next.trim()) fs.writeFileSync(file, next);
    else fs.unlinkSync(file);
    return { path: file, changed: true };
  }
  return { path: file, changed: false };
}

function replaceManagedBlock(existing: string, block: string): string {
  const normalized = existing.replace(/\s+$/, "");
  const pattern = new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`, "m");
  if (pattern.test(normalized)) return `${normalized.replace(pattern, block)}\n`;
  return normalized ? `${normalized}\n\n${block}\n` : `${block}\n`;
}

function managedBlock(integrationBranch: string): string {
  return [
    START,
    "## worktree-fleet",
    "",
    "This repo uses `worktree-fleet` to coordinate AI agents across sibling Git worktrees.",
    "",
    "- Before creating, entering, removing, pruning, or repairing Git worktrees, run `worktree-fleet status --refresh-current` and read the fleet board.",
    "- After creating or entering a worktree, run `worktree-fleet status --refresh-current` inside that worktree before editing.",
    `- Before catching up with \`${integrationBranch}\`, run \`worktree-fleet sync\` instead of raw \`git pull\`, \`git merge ${integrationBranch}\`, or \`git rebase ${integrationBranch}\`.`,
    "- To land completed work, run `worktree-fleet land` from the completed worktree instead of manually switching to the integration branch and merging.",
    "- If status shows pending, divergent, blocked, dirty, or contended work, surface that state before continuing.",
    "- If the user names files or areas of work, declare intent with `worktree-fleet intent declare <path...>`.",
    END
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
