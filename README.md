# worktree-fleet

Add the Claude Code plugin. Open Claude in a repo. Work normally.

`worktree-fleet` keeps parallel Claude sessions in sibling Git worktrees aware of each other. When one worktree advances your integration branch, the others see it, catch up when safe, or get a clear blocked message when a human decision is needed.

No central service. No hidden branches. No `git stash`. No stale-main drift quietly piling up behind your back.

## Install For Claude

In Claude Code:

```text
/plugin marketplace add mgdickinson/worktree-fleet
/plugin install worktree-fleet@worktree-fleet
```

That's it.

Now open Claude in any Git repo. On session start, the plugin initializes fleet state for that repo, installs safe Git hook blocks, registers the Claude session, and starts a small local monitor.

From then on, Claude has fleet awareness while it works.

## What You Get

- Active Claude sessions across sibling worktrees
- Dirty files and declared edit intent
- Pending integration-branch updates
- Safe automatic catch-up when possible
- Clear blocked states when sync would be risky
- A live dashboard with `worktree-fleet watch`
- Local activity logs so you can see what happened later

Most days, you do not need to touch the CLI. The plugin is the point.

## The Nice Button

When you want to see the fleet:

```sh
worktree-fleet watch
```

It shows sessions, worktrees, dirty files, intents, pending updates, blocked reasons, divergent targets, and recent activity.

When you want a one-shot health check:

```sh
worktree-fleet status --refresh-current
```

When you want to force the current worktree to catch up:

```sh
worktree-fleet sync
```

## Why This Exists

Claude is great at running multiple focused worktree sessions. Git is great at letting those worktrees drift apart while nobody notices.

`worktree-fleet` closes that gap. It records exact main-advance SHAs locally, watches active sessions, and only integrates when the current worktree is safe to touch. If there are staged changes, dirty overlap, an active merge/rebase, a missing commit object, or divergent main targets, it stops and tells you why.

## What Gets Installed

State lives under:

```text
~/.worktree-fleet/
├── activity/
├── adapters/
├── bus/main-events/
├── intents/
├── repos/
└── sessions/
```

The Claude plugin installs managed blocks into the repo's Git hooks. Existing hook content is preserved. Hook failures are logged and do not block normal Git commands.

Remove fleet-managed hooks and local adapter registration with:

```sh
worktree-fleet uninstall
```

## Codex And Other CLIs

Claude gets the native plugin path. Codex currently uses the wrapper path:

```sh
npm install -g @mgdickinson/worktree-fleet
cd /path/to/repo
worktree-fleet setup --adapter codex
fleet codex
```

`fleet codex` runs `codex` if it is on `PATH`, otherwise it falls back to the Codex.app binary at `/Applications/Codex.app/Contents/Resources/codex`. Set `WORKTREE_FLEET_CODEX_BIN=/path/to/codex` if your Codex binary lives somewhere else.

For any other CLI agent:

```sh
worktree-fleet session start --agent generic-cli -- <command...>
```

## CLI Reference

```sh
worktree-fleet setup [--adapter claude|codex|generic-cli] [--no-adapters]
worktree-fleet init
worktree-fleet status [--refresh-current]
worktree-fleet watch [--interval 2] [--once] [--no-refresh-current]
worktree-fleet activity [--limit 30] [--all] [--json]
worktree-fleet sync
worktree-fleet intent declare <path...>
worktree-fleet intent release <path...>
worktree-fleet adapter list
worktree-fleet doctor
worktree-fleet uninstall
fleet codex [-- <codex args...>]
```

## Safety Model

- Main-update events carry exact commit SHAs.
- Repo identity is local and object-store based.
- Integration blocks on active Git operations, staged changes, dirty overlap, missing target objects, and divergent main targets.
- No stash, autostash, hidden branches, or shared mutable Git scratch state.
- Activity artifacts are local only: `~/.worktree-fleet/activity/*.jsonl`.

## Local Development

```sh
git clone https://github.com/mgdickinson/worktree-fleet.git
cd worktree-fleet
npm install
npm test
claude plugin validate .
claude plugin validate plugins/worktree-fleet-claude
```

Test the Claude plugin locally before publishing changes:

```sh
npm run build
cd /path/to/repo
claude --plugin-dir /path/to/worktree-fleet/plugins/worktree-fleet-claude
```

Use an isolated state root while testing:

```sh
export WORKTREE_FLEET_HOME="$(mktemp -d)"
```

## License

MIT
