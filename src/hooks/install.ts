import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../core/fs.js";
import { stateRoot } from "../core/paths.js";
import { git } from "../git/command.js";
import { getCommonDir, getRepoRoot } from "../git/repo.js";

const HOOKS = ["post-commit", "post-merge", "post-rewrite"];
const START = "# >>> worktree-fleet managed block >>>";
const END = "# <<< worktree-fleet managed block <<<";

function hookRunnerPath(): string {
  const binDir = path.join(stateRoot(), "bin");
  ensureDir(binDir);

  const sourceCli = fs.realpathSync.native(process.argv[1] ?? "");
  const runtimeId = `${Date.now()}-${process.pid}`;
  const runtimeDir = path.join(stateRoot(), "runtime", runtimeId);
  const sourceDist = path.resolve(path.dirname(sourceCli), "..");
  const runtimeDist = path.join(runtimeDir, "dist");
  ensureDir(runtimeDir);
  fs.cpSync(sourceDist, runtimeDist, { recursive: true });

  const runner = path.join(binDir, "worktree-fleet-hook");
  const contents = `#!/bin/sh
exec "${process.execPath}" "${path.join(runtimeDist, "cli", "index.js")}" "$@"
`;
  fs.writeFileSync(runner, contents, { mode: 0o755 });
  fs.chmodSync(runner, 0o755);
  pruneOldRuntimeSnapshots(runtimeId);
  return runner;
}

function block(bin: string): string {
  return `${START}
if "${bin}" hook main-advanced "$PWD"; then
  :
else
  status=$?
  "${bin}" hook log-failure main-advanced "$PWD" "$status" || true
fi
${END}`;
}

export function installHooks(cwd: string, bin = hookRunnerPath()): string[] {
  const hooksDir = getHooksDir(cwd);
  fs.mkdirSync(hooksDir, { recursive: true });
  const changed: string[] = [];

  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "#!/bin/sh\n";
    const nextBlock = block(bin);
    let next = existing;
    if (existing.includes(START) && existing.includes(END)) {
      next = existing.replace(new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`), nextBlock);
    } else {
      next = `${existing.trimEnd()}\n\n${nextBlock}\n`;
    }
    if (next !== existing) {
      fs.writeFileSync(hookPath, next, { mode: 0o755 });
      fs.chmodSync(hookPath, 0o755);
      changed.push(hookPath);
    }
  }

  return changed;
}

export function uninstallHooks(cwd: string): string[] {
  const hooksDir = getHooksDir(cwd);
  const changed: string[] = [];
  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    if (!fs.existsSync(hookPath)) continue;
    const existing = fs.readFileSync(hookPath, "utf8");
    const next = existing.replace(new RegExp(`\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`), "\n").trimEnd() + "\n";
    if (next !== existing) {
      fs.writeFileSync(hookPath, next, { mode: 0o755 });
      changed.push(hookPath);
    }
  }
  return changed;
}

export function managedHooksInstalled(cwd: string): boolean {
  const hooksDir = getHooksDir(cwd);
  return HOOKS.every((hook) => {
    const hookPath = path.join(hooksDir, hook);
    return fs.existsSync(hookPath) && fs.readFileSync(hookPath, "utf8").includes(START);
  });
}

function getHooksDir(cwd: string): string {
  const configured = git(cwd, ["config", "--get", "core.hooksPath"]);
  if (configured.ok && configured.stdout) {
    return path.isAbsolute(configured.stdout)
      ? configured.stdout
      : path.resolve(getRepoRoot(cwd), configured.stdout);
  }
  return path.join(getCommonDir(cwd), "hooks");
}

function pruneOldRuntimeSnapshots(activeRuntimeId: string): void {
  const runtimeRoot = path.join(stateRoot(), "runtime");
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === activeRuntimeId) continue;
    fs.rmSync(path.join(runtimeRoot, entry.name), { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
