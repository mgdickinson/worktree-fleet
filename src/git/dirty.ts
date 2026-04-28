import { gitOrThrow } from "./command.js";

function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function getDirtyFiles(cwd: string): string[] {
  const unstaged = lines(gitOrThrow(cwd, ["diff", "--name-only"]));
  const staged = lines(gitOrThrow(cwd, ["diff", "--cached", "--name-only"]));
  const untracked = lines(gitOrThrow(cwd, ["ls-files", "--others", "--exclude-standard"]));
  return Array.from(new Set([...unstaged, ...staged, ...untracked])).sort();
}

export function getStagedFiles(cwd: string): string[] {
  return lines(gitOrThrow(cwd, ["diff", "--cached", "--name-only"])).sort();
}

export function getIncomingFiles(cwd: string, target: string): string[] {
  try {
    return lines(gitOrThrow(cwd, ["diff", "--name-only", `HEAD...${target}`])).sort();
  } catch {
    return lines(gitOrThrow(cwd, ["diff", "--name-only", `HEAD..${target}`])).sort();
  }
}
