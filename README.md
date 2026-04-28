# worktree-fleet

Local coordination for Claude Code, Codex, and other AI coding sessions working in sibling Git worktrees.

`worktree-fleet` gives each session a shared local view of the fleet: active worktrees, dirty files, declared intent, pending `main` updates, blocked syncs, divergent targets, and recent activity. It is conservative by design: exact commit SHAs, no `git stash`, no hidden coordination branches, no central daemon, and no silent drift.

## Why

When several AI sessions work in sibling worktrees, one session can land on `main` while others keep editing stale branches. `worktree-fleet` makes that movement visible and safely catches each session up when it can. When it cannot, it leaves a clear blocked state instead of guessing.

## Install

### Claude Code plugin

Add the public marketplace from GitHub, then install the plugin:

```text
/plugin marketplace add mgdickinson/worktree-fleet
/plugin install worktree-fleet@worktree-fleet
```

Or from a shell:

```sh
claude plugin marketplace add mgdickinson/worktree-fleet
claude plugin install worktree-fleet@worktree-fleet
```

Then open Claude in a Git repo. On `SessionStart`, the plugin initializes fleet state for that repo, installs fleet-managed Git hook blocks, registers the Claude session, and starts the monitor sidecar.

### CLI and Codex

```sh
npm install -g @mgdickinson/worktree-fleet
cd /path/to/repo
worktree-fleet setup --adapter codex
fleet codex
```

For any other CLI agent:

```sh
worktree-fleet session start --agent generic-cli -- <command...>
```

## Daily Use

```sh
worktree-fleet watch
worktree-fleet status --refresh-current
worktree-fleet activity
worktree-fleet sync
worktree-fleet intent declare app/models/user.rb
worktree-fleet intent release app/models/user.rb
worktree-fleet doctor
```

`watch` is the live dashboard. It shows fleet health, sessions, dirty files, intent, contention, pending main targets, blocked reasons, divergent SHAs, and recent main events.

`activity` is the durable usage trail. It reads local JSONL artifacts from `~/.worktree-fleet/activity/` so you can inspect what fleet did after the fact.

`sync` runs the safe catch-up algorithm for the current worktree. It merges the exact pending target when safe, otherwise it blocks with a visible reason.

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

The Claude plugin and `setup` install managed blocks into the repo's Git hooks. Existing hook content is preserved. Remove those blocks with:

```sh
worktree-fleet uninstall
```

## Safety Model

- Main-update events carry exact commit SHAs.
- Repo identity is local and object-store based: `sha256(realpath(git rev-parse --git-common-dir))`.
- Integration blocks on active Git operations, staged changes, dirty overlap, missing target objects, and divergent main targets.
- No stash, autostash, hidden branches, or shared mutable Git scratch state.
- Managed Git hooks use an absolute runner path, preserve existing hook content, and log failures without blocking Git operations.
- Claude auto-initializes a repo only after the user installs/enables the plugin.
- Activity artifacts are local only: `~/.worktree-fleet/activity/*.jsonl`.

## Commands

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
