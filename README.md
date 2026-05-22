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

If Claude tries to manually `git pull`, `git merge main`, or `git rebase main`, the plugin redirects it back through `worktree-fleet sync` so fleet can do the safety check first.

If Claude tries to mutate worktrees with raw Git, the plugin makes it check the fleet board first.

## What You Get

- Active Claude sessions across sibling worktrees
- Changed files, host-observed tool paths, and optional planned intent
- Pending integration-branch updates
- Safe automatic catch-up when possible
- Clear blocked states when sync would be risky
- A live observer with `worktree-fleet observe`
- Local activity logs so you can see what happened later

Most days, you do not need to touch the CLI. The plugin is the point.

## The Nice Button

When you want to see whether fleet is actually working:

```sh
worktree-fleet observe
```

It opens a local dashboard with working status, agent heartbeat health, process liveness, safety hook status, pending catch-ups, sync blocks, divergent main targets, path contention, recent main events, and the local activity feed.

When you want the terminal version:

```sh
worktree-fleet watch
```

It shows sessions, worktrees, changed files, observed tool paths, optional planned intent, pending updates, blocked reasons, divergent targets, and recent activity in a compact terminal frame. Use `worktree-fleet watch --web` to launch the local observer from the watch command.

When you want a one-shot health check:

```sh
worktree-fleet status --refresh-current
```

When you want to force the current worktree to catch up:

```sh
worktree-fleet sync
```

When a feature worktree is ready to land onto local main:

```sh
worktree-fleet land
```

`land` syncs first, requires clean current and integration worktrees, fast-forwards the local integration branch, and records the main-advance event for sibling sessions.

When you want the local audit trail, including Claude monitor starts, stops, and sidecar errors:

```sh
worktree-fleet activity --all --limit 50
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

Claude monitor and sidecar diagnostics are recorded in `~/.worktree-fleet/activity/*.jsonl` as `sidecar-started`, `sidecar-error`, and `sidecar-stopped` events.

Remove fleet-managed hooks and local adapter registration with:

```sh
worktree-fleet uninstall
```

## Codex And Other CLIs

Claude gets the native plugin path. Codex has two pieces:

- the Codex plugin, which gives Codex the fleet-aware skills
- a repo `AGENTS.md` block, which tells native Codex sessions to use fleet before worktree, sync, and land operations
- the `fleet codex` wrapper, which gives CLI Codex heartbeat/session sidecar behavior

For native Codex, install the package once and stamp the current repo:

```sh
npm install -g @mgdickinson/worktree-fleet
cd /path/to/repo
worktree-fleet setup --adapter codex
```

`worktree-fleet setup --adapter codex` writes a managed block into the repo's `AGENTS.md`. That gives Codex native app sessions repo-level instructions to check the fleet board before worktree operations, use `worktree-fleet sync` for catch-up, and use `worktree-fleet land` for merging completed work back to local main. Existing `AGENTS.md` content is preserved; `worktree-fleet adapter uninstall codex` removes only the managed block.

Install the Codex plugin marketplace:

```sh
codex plugin marketplace add mgdickinson/worktree-fleet
```

Then enable `worktree-fleet-codex` in Codex's plugin UI. If you prefer config, add this to `~/.codex/config.toml`:

```toml
[plugins."worktree-fleet-codex@worktree-fleet"]
enabled = true
```

Restart Codex or start a new session. Codex should then load:

- `worktree-fleet-codex:worktree-fleet`
- `worktree-fleet-codex:using-git-worktrees`

For CLI Codex, use the wrapper too:

```sh
cd /path/to/repo
worktree-fleet setup --adapter codex
fleet codex
```

`fleet codex` runs `codex` if it is on `PATH`, otherwise it falls back to the Codex.app binary at `/Applications/Codex.app/Contents/Resources/codex`. Set `WORKTREE_FLEET_CODEX_BIN=/path/to/codex` if your Codex binary lives somewhere else.

The Codex plugin and `AGENTS.md` instructions are guidance-only until Codex exposes native lifecycle hooks. They teach Codex to use fleet-aware workflows, but they do not create automatic per-turn hooks. The wrapper remains the automatic heartbeat/sync path.

For any other CLI agent:

```sh
worktree-fleet session start --agent generic-cli -- <command...>
```

## Repo Instruction Snippets

The Claude plugin and Codex plugin give agents fleet awareness, but repo memory still matters. If your project keeps persistent agent instructions, add a short fleet block so new sessions know what the observer means and which commands are safe.

For Codex, the easiest path is:

```sh
worktree-fleet setup --adapter codex
```

That writes a managed `worktree-fleet` block into `AGENTS.md`. If you maintain instructions manually, include something like this in `AGENTS.md`:

```md
## worktree-fleet

This repo uses `worktree-fleet` to coordinate AI agents across sibling Git worktrees.

- Before substantial edits, run `worktree-fleet status --refresh-current` and read the fleet state.
- Before creating, entering, removing, pruning, or repairing Git worktrees, run `worktree-fleet status --refresh-current`.
- After creating or entering a worktree, run `worktree-fleet status --refresh-current` inside that worktree before editing.
- Do not catch up with raw `git pull`, `git merge main`, or `git rebase main`; run `worktree-fleet sync` instead. Replace `main` with the repo's integration branch if different.
- To land completed work, run `worktree-fleet land` from the completed worktree instead of manually switching to the integration branch and merging.
- If fleet status shows pending, divergent, blocked, changed, observed, planned, or contended work, surface that state before continuing.
- Fleet automatically tracks changed files and host-observed tool paths. Use `worktree-fleet intent declare <path...>` only when you need an early warning before files are touched, and release it with `worktree-fleet intent release <path...>` when that planned work is no longer active.
- Use `worktree-fleet observe` when the user asks whether fleet is working or wants to inspect active sessions.
```

For Claude, add the same operating rules to `CLAUDE.md`:

```md
## worktree-fleet

This repo uses `worktree-fleet` for multi-agent Git worktree coordination.

- Start work by checking `worktree-fleet status --refresh-current` when the task may touch Git state, worktrees, or shared files.
- Treat `worktree-fleet observe` as the human-facing source of truth for active sessions, heartbeats, pending main updates, blocked syncs, divergence, and path contention.
- Use `worktree-fleet sync` instead of raw `git pull`, `git merge main`, or `git rebase main` when catching up with the integration branch.
- Use `worktree-fleet land` to merge completed work back to the integration branch.
- Before worktree lifecycle changes, inspect fleet status and report any pending, divergent, blocked, changed, observed, planned, or contended state.
- Fleet automatically tracks changed files and host-observed tool paths. Publish planned intent with `worktree-fleet intent declare <path...>` only when early warning is useful before files are touched, and release it when the planned work is no longer active.
- Never bypass a worktree-fleet hook block; follow the message and ask for human help if the state requires a decision.
```

## CLI Reference

```sh
worktree-fleet setup [--adapter claude|codex|generic-cli] [--no-adapters]
worktree-fleet init
worktree-fleet status [--refresh-current]
worktree-fleet observe [--host 127.0.0.1] [--port 0] [--interval 2] [--no-open] [--no-refresh-current]
worktree-fleet watch [--interval 2] [--once] [--web] [--no-refresh-current]
worktree-fleet activity [--limit 30] [--all] [--json]
worktree-fleet sync
worktree-fleet land
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
- Landing blocks unless the current worktree and local integration worktree are clean and the integration branch can fast-forward to the current HEAD.
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
