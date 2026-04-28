import { git } from "./command.js";

export function objectExists(cwd: string, sha: string): boolean {
  return git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).ok;
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

export function contains(cwd: string, container: string, maybeAncestor: string): boolean {
  return isAncestor(cwd, maybeAncestor, container);
}
