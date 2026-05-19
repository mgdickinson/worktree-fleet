# Worktree Fleet Package Architecture

**Status:** Design + v0 implementation
**Date:** 2026-04-28
**Related:** [Worktree Fleet Coordination Architecture](./2026-04-28-fleet-coordination-design.md)

## Purpose

Turn the current coordination design into a GitHub-ready package that a single developer can install, run locally, and use across mixed AI coding sessions: Claude Code, Codex, and generic CLI agents in sibling git worktrees.

The package should feel boring to install and hard to misuse. The core Git behavior should stay conservative: exact target SHAs, no stash, no shared mutable Git scratch state, visible blocked states, and no silent drift.

## Current State

The repo now contains a TypeScript/npm implementation of the first usable package surface:

- shared state directory: `~/.worktree-fleet/`
- per-session state and intent files
- explicit adapter registration files
- published dirty snapshots
- main-update event log
- per-session main-event cursors
- ancestry-based pending target normalization
- safe CLI/wrapper integration
- Claude plugin hooks/monitor, Codex wrapper adapter, and generic CLI wrapper
- bundled repo-local Codex plugin scaffold
- CLI-first human commands
- integration tests and GitHub Actions CI

Native Codex lifecycle hooks remain adapter work. The package-owned behavior is implemented in the CLI/core. Claude Code plugin hooks are now represented by a packaged `.claude-plugin/plugin.json` that points at bundled hooks, monitor, and skills.

## Target Package

Package name: `worktree-fleet`

Primary install path:

```text
install worktree-fleet plugin in Claude and/or Codex
open a git worktree
approve "Initialize worktree-fleet for this repo?"
start using /fleet or worktree-fleet status
```

Universal CLI fallback:

```sh
npm exec --package /worktree-fleet -- worktree-fleet setup
worktree-fleet doctor
worktree-fleet plugin path codex
```

Primary daily commands:

```sh
worktree-fleet status
worktree-fleet sync
worktree-fleet intents
worktree-fleet intent declare app/models/user.rb spec/models/user_spec.rb
worktree-fleet intent release app/models/user.rb
```

Claude should expose `/fleet`, `/sync`, and `/intents` as aliases when its host plugin is present. Codex currently ships a bundled plugin scaffold plus the `fleet codex` wrapper/sidecar flow, and may upgrade to native hooks later if the host exposes stable lifecycle APIs.

## Design Principles

- **Agent-agnostic core.** Claude and Codex are adapters, not product boundaries.
- **No central daemon.** Per-session sidecars are acceptable; a fleet-wide process is not required.
- **No shared Git scratch state.** No `git stash`, no coordination refs, no hidden shared branches.
- **Exact targets.** Every main-update signal carries repo/ref/SHA.
- **Per-machine repo identity.** `repo_id` is derived from the local common object store, not from a remote URL.
- **Ancestry over time.** Pending targets advance by commit containment, not event timestamp.
- **Published snapshots.** Sessions publish their own dirty state; status does not run Git in sibling worktrees by default.
- **Safe by stopping.** Blocked integration is a correct result.
- **Easy uninstall.** Remove only fleet-managed hook blocks and adapter registration.

## Repository Layout

Recommended initial layout:

```text
.
├── package.json
├── tsconfig.json
├── README.md
├── docs/
│   └── specs/
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   ├── fleet.ts
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── doctor.ts
│   │   │   ├── status.ts
│   │   │   ├── sync.ts
│   │   │   ├── migrate.ts
│   │   │   ├── intents.ts
│   │   │   ├── adapter.ts
│   │   │   └── session.ts
│   │   └── format.ts
│   ├── core/
│   │   ├── config.ts
│   │   ├── paths.ts
│   │   ├── state.ts
│   │   ├── locks.ts
│   │   ├── atomic-write.ts
│   │   ├── events.ts
│   │   ├── pending-targets.ts
│   │   ├── dirty.ts
│   │   ├── integration.ts
│   │   ├── contention.ts
│   │   └── doctor.ts
│   ├── git/
│   │   ├── repo.ts
│   │   ├── dirty.ts
│   │   ├── ancestry.ts
│   │   ├── operations.ts
│   │   ├── fetch.ts
│   │   └── merge.ts
│   ├── adapters/
│   │   ├── sdk.ts
│   │   ├── generic/
│   │   ├── claude/
│   │   └── codex/
│   ├── hooks/
│   │   ├── install.ts
│   │   ├── uninstall.ts
│   │   └── main-advance-hook.sh
│   └── sidecar/
│       ├── run.ts
│       ├── heartbeat.ts
│       ├── watch-events.ts
│       └── fetch-tick.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
    └── release.ts
```

TypeScript is a good default because the package is CLI-heavy, easy to publish via npm, and friendly to JSON/state tooling. The Git behavior should be implemented by shelling out to `git` with explicit argument arrays, not by ad hoc string commands.

The npm package should expose two bins:

```json
{
  "bin": {
    "worktree-fleet": "./dist/cli/index.js",
    "fleet": "./dist/cli/fleet.js"
  }
}
```

`fleet` is intentionally a tiny launcher surface. Initially it only needs `fleet codex`, which delegates to wrapper mode. Setup may install a fleet-managed shim only when the npm bin is unavailable to a plugin host; any shim path must be recorded in state and removed by uninstall.

## Package Boundaries

### Core

The core package owns behavior that must be identical across agents:

- state directory creation
- schema read/write
- atomic JSON writes
- advisory locks
- session registration and stale sweep
- intent updates
- dirty snapshot publishing
- main-update event creation
- pending-target normalization
- contention computation
- safe integration
- doctor checks

The core must not depend on Claude or Codex APIs.

### Git Layer

The Git layer wraps every Git operation behind typed helpers:

- `getRepoInfo(cwd)`
- `getRepoId(cwd)`
- `getBranch(cwd)`
- `getHeadSha(cwd)`
- `getDirtySnapshot(cwd)`
- `isAncestor(cwd, ancestor, descendant)`
- `contains(cwd, container, maybeAncestor)`
- `getActiveOperation(cwd)`
- `fetchWithLease(repoId, cwd)`
- `mergeTarget(cwd, sha)`
- `changedFilesSinceDivergence(cwd, targetSha)`

Every helper returns structured errors. The integration layer should never parse arbitrary human-facing Git output except as diagnostic text.

### Adapters

Adapters map host-specific lifecycle events to the core lifecycle:

```ts
type AgentKind = "claude-code" | "codex" | "generic-cli";

interface FleetAdapter {
  agentKind: AgentKind;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  doctor(): Promise<DoctorCheck[]>;
}
```

Core lifecycle:

- `session_start`
- `heartbeat`
- `before_write(paths)`
- `turn_stop`
- `sync_now`
- `declare_intent(files)`
- `release_intent(files)`
- `fleet_status`

Adapters can be full fidelity or partial fidelity. Correctness comes from dirty snapshots and safe integration; `before_write` only improves early contention signals.

## State Model

State root:

```text
~/.worktree-fleet/
├── config.json
├── sessions/
├── intents/
├── adapters/
├── repos/
└── bus/main-events/
```

All durable JSON records include `schema_version`. Version `1` is the initial public schema.

Config file:

```json
{
  "schema_version": 1,
  "created_at": "2026-04-28T14:32:00Z",
  "updated_at": "2026-04-28T14:32:00Z"
}
```

Session file:

```json
{
  "schema_version": 1,
  "session_id": "uuid",
  "agent_kind": "codex",
  "adapter": "worktree-fleet-codex",
  "adapter_version": "0.1.0",
  "pid": 12345,
  "worktree_path": "/abs/path/to/worktree",
  "repo_id": "sha256-of-git-common-dir",
  "branch": "feature-x",
  "started_at": "2026-04-28T14:32:00Z",
  "heartbeat_at": "2026-04-28T14:42:00Z",
  "dirty_files": [],
  "dirty_refreshed_at": "2026-04-28T14:42:00Z",
  "last_absorbed_event_id": null,
  "integration": {
    "pending": null,
    "blocked": false,
    "blocked_event_id": null,
    "blocked_files": [],
    "blocked_reason": null,
    "divergent_targets": [],
    "last_notified_block_key": null,
    "last_integrated_sha": "abc123"
  }
}
```

Adapter registration:

```json
{
  "schema_version": 1,
  "kind": "codex",
  "mode": "wrapper",
  "installed_at": "2026-04-28T14:42:00Z",
  "updated_at": "2026-04-28T14:42:00Z",
  "package_bin": "fleet",
  "command": "fleet codex",
  "native_lifecycle": false,
  "notes": [
    "Wrapper mode launches Codex under `fleet codex` and syncs through the sidecar."
  ]
}
```

Adapter registration is an explicit-consent record. It is not proof that a host-native plugin API exists; `mode` and `native_lifecycle` must say whether the package is using a wrapper, a host-managed native adapter, or a generic session wrapper.

`repo_id` is `sha256(realpath(git rev-parse --git-common-dir))`. Fleet state is per-machine and per shared object store. The origin URL may be stored as remote metadata, but it is not the local event identity because local main events can point at objects that only exist in one clone. If cross-machine coordination becomes a future goal, add a separate `remote_id`; do not overload `repo_id`.

`heartbeat_at` is a liveness signal, not just display data. A session is stale when `heartbeat_at` is older than the configured stale threshold. The default stale heartbeat threshold is 5 minutes. PID is useful for diagnostics and lock recovery, but dead-PID session sweeps are intentionally avoided so one-shot CLI snapshots remain visible until their heartbeat expires.

Intent file:

```json
{
  "schema_version": 1,
  "session_id": "uuid",
  "tool_touched": [],
  "upcoming": [],
  "updated_at": "2026-04-28T14:42:00Z"
}
```

Main event:

```json
{
  "schema_version": 1,
  "event_id": "2026-04-28T14-43-02-123Z-<repo_id>-<sha>",
  "repo_id": "sha256-of-git-common-dir",
  "source": "local-main",
  "ref": "main",
  "sha": "abc123",
  "created_at": "2026-04-28T14:43:02.123Z"
}
```

Repo metadata:

```text
~/.worktree-fleet/repos/<repo_id>/
├── config.json
├── fetch.lock
├── last-fetch.json
└── last-main-event
```

`config.json` records the detected integration branch and remote:

```json
{
  "schema_version": 1,
  "repo_id": "sha256-of-git-common-dir",
  "integration_branch": "main",
  "integration_remote": "origin",
  "integration_remote_ref": "origin/main",
  "created_at": "2026-04-28T14:42:00Z",
  "updated_at": "2026-04-28T14:42:00Z"
}
```

`last-fetch.json` is updated under `fetch.lock`:

```json
{
  "schema_version": 1,
  "repo_id": "sha256-of-git-common-dir",
  "remote": "origin",
  "ref": "refs/remotes/origin/main",
  "last_fetch_attempt_at": "2026-04-28T14:42:30Z",
  "last_fetch_success_at": "2026-04-28T14:42:31Z",
  "last_observed_sha": "abc123",
  "last_error": null
}
```

`fetch.lock` is an advisory lock file, not the source of truth. Stale-lock recovery is required: lock metadata records owner PID, hostname, and acquired time. The default lock TTL is 60 seconds. A contender may steal the lock when `acquired_at + TTL < now` and the same-host owner PID is gone; if the owner cannot be checked reliably, it may steal only after TTL expiry. `last-main-event` stores the last local `main` SHA emitted by hooks so repeated hook invocations stay idempotent.

Schema handling:

1. Core readers accept the current `schema_version`.
2. Older supported versions are migrated under the same lock and atomic-write rules as normal state updates.
3. Newer unsupported versions are never rewritten; `doctor` reports an actionable failure instead.
4. Read/modify/write paths preserve unknown fields where practical so additive fields survive mixed adapter versions.
5. `worktree-fleet migrate` runs idempotent migrations explicitly; `setup` may offer to run safe migrations after showing the affected files.

## Core Algorithms

### Atomic Writes

For JSON state:

1. Acquire the relevant advisory lock if the file is mutable.
2. Write to `path.tmp.<pid>.<nonce>`.
3. `fsync` the temp file.
4. `rename()` over the destination.
5. `fsync` the parent directory.
6. Release the lock.

Readers ignore temp files.

### Dirty Snapshot

Each session publishes its own dirty snapshot:

```sh
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

Refresh points:

- `session_start`
- heartbeat tick
- after `before_write`
- before `turn_stop`
- after `turn_stop`
- `worktree-fleet status --refresh-current`

Status reads sibling snapshots from state and displays `dirty_refreshed_at`.

### Pending Target Normalization

Maintain maximal main candidates by ancestry:

- drop candidates already contained by `HEAD`
- drop candidates contained by another candidate
- one remaining candidate becomes `pending`
- multiple remaining candidates become `pending + divergent_targets`

Never choose by event timestamp except as a stable display/default when multiple incomparable candidates remain.

Each session stores `last_absorbed_event_id`. Event absorption skips repo events at or below that cursor, then advances the cursor after each processed event. This keeps routine sync O(new events) while preserving the append-only event bus.

If a watcher advances `pending.sha` or changes `divergent_targets` while `integration.blocked` is already true, the watcher treats `blocked_files`, `blocked_reason`, and `blocked_event_id` as stale. It does not recompute them in the watcher. The next `turn_stop` recomputes blocked metadata against the current target and injects a message only if the resulting block key changed.

### Safe Integration

At `turn_stop`:

1. Refresh dirty snapshot.
2. Detect active Git operation (`MERGE_HEAD`, rebase, cherry-pick, revert); block if present.
3. Normalize pending targets.
4. Fetch any missing target candidate objects under the per-repo fetch lease.
5. Re-normalize pending targets after any successful fetch so newly available ancestry can collapse stale divergence.
6. Block on target divergence.
7. Block on staged index.
8. Compute incoming files with `git diff --name-only HEAD...target`.
9. Block if dirty files overlap incoming files.
10. `git merge --no-edit <target>`.
11. Clear pending only if target is integrated and no newer pending event replaced it.
12. Refresh dirty snapshot again.

No stash. No autostash. No coordination refs.

### Event Retention

The first implementation keeps the event bus append-only during normal operation and provides an explicit maintenance command:

```sh
worktree-fleet gc --days 30
```

GC removes main-event files older than the chosen age. Per-session event cursors prevent normal sync from rereading historical events before GC is needed.

## Developer Ergonomics

The happy path should feel like installing a plugin, not wiring a distributed system by hand.

Default posture:

- plugin install is the preferred install surface
- plugin bootstraps the core package automatically
- missing repo config triggers an inline "initialize this repo?" prompt
- existing repo config means the adapter starts using fleet immediately
- auto-detect Claude and Codex where possible
- safe defaults with no prompts unless something risky is about to change
- `doctor` for troubleshooting, not for the normal path

### Lazy Bootstrap

Adapters should follow the same startup rule in every agent:

```
on session start:
  if worktree-fleet core is missing:
    ask to install it
  if current directory is not a git worktree:
    stay inactive and explain why
  if repo is not initialized for worktree-fleet:
    ask: "Initialize worktree-fleet for this repo?"
    if yes:
      run setup for this repo
    if no:
      stay inactive for this repo
  if repo is initialized:
    register session and start normal adapter behavior
```

This makes the common case feel automatic:

- no file/config detected: ask once
- file/config detected: use the plugin as intended
- setup broken: show a focused repair prompt

The first-run prompt should be short:

```text
worktree-fleet is not initialized for this repo.

Initialize it? This will add fleet-managed git hook blocks and create ~/.worktree-fleet/.
```

Adapter setup is prompted separately because it can modify agent-specific config or install launcher shims. The prompt should have a "show details" path, but the default explanation should stay small. Details must list the exact hook files, adapter config files, launcher paths, and sidecar behavior that will change.

### Magic Path From Claude

Preferred path:

```text
install worktree-fleet plugin
open a repo in Claude
Claude asks: "Initialize worktree-fleet for this repo?"
choose yes
/fleet works
```

The Claude plugin should install or locate the core package itself. The user should not have to know npm exists. Under the hood, the plugin can use the npm package, a bundled binary, or a GitHub release asset. That is an implementation detail.

Manual escape hatch:

```sh
npm exec --package /worktree-fleet -- worktree-fleet setup
```

`setup` is the "do the right thing" command. It should:

1. Detect the git repository and common git directory.
2. Create `~/.worktree-fleet/`.
3. Install or update the repo-level main-advance hook bundle.
4. Preserve and chain existing hooks.
5. Enable or recommend `git rerere`.
6. Detect installed AI tools (`claude`, `codex`, and known agent CLIs).
7. Present detected adapters with the exact config files, launcher paths, and sidecars they would add.
8. Install only adapters the user explicitly confirms, or adapters selected by flags.
9. Start or configure sidecars only for installed adapters.
10. Print a short success message plus the one command to view status.

Adapter consent flags:

- `--adapter <kind>` installs only the named adapter; repeatable.
- `--no-adapters` skips adapter installation even when tools are detected.
- `--all-adapters` opts into every detected adapter.
- `--yes` accepts noninteractive prompts, but it does not imply `--all-adapters`; noninteractive adapter installation still needs `--adapter` or `--all-adapters`.

This keeps `npm exec --package /worktree-fleet -- worktree-fleet setup --yes` safe for repo hooks and state, while making cross-tool config changes explicit.

Ideal output:

```text
worktree-fleet ready

repo      /Users/matt/code/app
hooks     installed
claude    plugin hooks active: SessionStart, PreToolUse, Stop, SessionEnd
codex     wrapper available: use `fleet codex`
codex     plugin scaffold: worktree-fleet plugin path codex

run `worktree-fleet status` any time
```

The explicit commands still exist for users who want control or for debugging:

```sh
npm install -g /worktree-fleet
worktree-fleet init
worktree-fleet adapter install claude
worktree-fleet adapter install codex
worktree-fleet adapter list
worktree-fleet plugin path codex
```

But the docs and README should lead with plugin install and lazy bootstrap, with `npm exec --package /worktree-fleet -- worktree-fleet setup` as the universal fallback.

### Claude Plugin Flow

Claude should get the most magical path because it can be the high-fidelity adapter.

Target UX inside Claude after plugin install:

```text
/fleet
```

If the repo is not initialized, `/fleet` should not error. It should offer setup:

```text
worktree-fleet is not initialized here.

Initialize this repo? [yes] [no] [details]
```

An explicit command can also exist:

```text
/fleet:init
```

The Claude adapter/plugin should be allowed to run setup itself:

- install the core package if missing
- run repo init from the current worktree
- install or update fleet-managed git hook blocks
- register MCP tools
- register `/fleet`, `/sync`, and `/intents`
- start the per-session adapter process
- show status immediately after setup

After initialization, the daily UX is just:

```text
/fleet
/sync
/intents
```

The plugin should not ask the user to separately run `worktree-fleet adapter install claude` unless automatic setup fails. If setup fails, it should print the exact fallback command.

### Codex Flow

Codex should also aim for magic, but the launch assumption is wrapper mode. Native lifecycle/plugin integration is an upgrade path when the host exposes a stable API surface; until then, the adapter/plugin should handle core install and repo initialization through the wrapper/sidecar path.

Best case:

1. Install the Codex worktree-fleet adapter/plugin.
2. Open a repo in Codex.
3. If no fleet config is detected, Codex asks whether to initialize.
4. If fleet config is detected, Codex registers the session and starts using it.

If native lifecycle integration becomes available, Codex sessions can auto-register and auto-sync at safe turn boundaries.

Fallback launcher, provided by the package bin and made visible by the plugin or setup:

```sh
fleet codex
```

The npm package also ships a repo-local Codex plugin scaffold:

```sh
worktree-fleet plugin path codex
```

That scaffold provides Codex workflow guidance for setup, status, sync, and intent commands, and the repo includes `.agents/plugins/marketplace.json` for local plugin development. It does not claim native lifecycle hooks. Native lifecycle mode remains a host-dependent upgrade path.

`fleet codex` is a tiny package-bin launcher. It expands to the wrapper mode:

```sh
worktree-fleet session start --agent codex -- codex
```

This is much easier to remember than the full wrapper command and still gives:

- session registration
- heartbeat
- dirty snapshots
- event watching
- fetch tick participation
- shared `worktree-fleet status`
- manual `worktree-fleet sync`

If wrapper mode cannot auto-sync exactly between turns, status should say so plainly:

```text
codex  feature-auth  manual-sync  pending abc123
```

The important ergonomic rule is the same as Claude:

- no config detected: ask to initialize
- config detected: start participating
- native integration unavailable: fall back to launcher/sidecar, clearly labeled

### Daily Use

Normal usage should be tiny:

```sh
worktree-fleet status
```

Claude:

```text
/fleet
```

Codex wrapper:

```sh
fleet codex
```

Manual sync when needed:

```sh
worktree-fleet sync
```

Declaring intent remains optional. It is useful for big tasks, but correctness must not depend on it:

```sh
worktree-fleet intent declare app/services/auth spec/services/auth
```

### What "Plugin" Means Here

There are three layers, but setup should hide them:

- **Core package:** the Git/state engine and CLI.
- **Repo hook integration:** git hooks installed once per repo.
- **Agent adapter/plugin:** a thin integration for Claude, Codex, or a generic wrapper.

The Claude plugin bootstraps the first two layers from inside Claude through packaged hooks and a monitor. Codex ships a repo-local plugin scaffold for workflow guidance and should use `fleet codex` as the human-friendly launch fallback, with native lifecycle behavior treated as a host-dependent upgrade path.

The user-facing concept is simply:

```text
install worktree-fleet
open Claude or Codex in a repo
say yes when asked to initialize
keep working
```

### Uninstall

Uninstall should be boring:

```sh
worktree-fleet adapter uninstall claude
worktree-fleet adapter uninstall codex
worktree-fleet uninstall
```

It removes only fleet-managed hook blocks, adapter registrations, and optional launcher shims. It should preserve state by default and require `--purge-state` to delete `~/.worktree-fleet/`.

## CLI Commands

### `worktree-fleet setup`

The friendly first-run command. It composes `init`, hook install/update, optional adapter install, sidecar configuration, and a final status summary.

Required flag behavior:

- `--adapter <kind>` installs only the named adapter; repeatable.
- `--no-adapters` skips adapter installation.
- `--all-adapters` installs all detected adapters.
- `--yes` answers setup prompts noninteractively, but does not install adapters unless paired with `--adapter` or `--all-adapters`.

Interactive setup should ask before adapter changes and show the exact files, shims, and sidecars that will be added.

### `worktree-fleet init`

Responsibilities:

- create state directory
- write default config
- install or update main-advance hook bundle
- compose with existing hooks
- enable or recommend `git rerere`
- print next steps for Claude/Codex adapters

### `worktree-fleet doctor`

Checks:

- Git available
- repo/worktree detected
- state root writable
- locks usable
- hook bundle installed and chained
- adapter registrations present
- active sessions heartbeating
- dirty snapshots fresh enough
- fetch lease readable/writable
- `rerere` configured
- status sees Claude and Codex sessions if both are active

Doctor should print actionable fixes:

```text
WARN codex adapter not installed
  fix: worktree-fleet adapter install codex

FAIL main-advance hook not installed
  fix: worktree-fleet init --hooks
```

### `worktree-fleet migrate`

Runs idempotent state migrations for supported older `schema_version` values. It must:

- acquire the relevant file or repo locks
- write through the normal atomic-write path
- preserve unknown fields where practical
- refuse newer unsupported schemas
- print the files it changed

### `worktree-fleet status`

Displays:

- session id short
- agent kind
- adapter mode, when registered
- branch
- worktree path
- pending SHA
- divergent target SHAs
- blocked reason
- dirty files
- upcoming intent
- contended files
- dirty snapshot age

### `worktree-fleet sync`

Runs `turn_stop` for the current session. If no session exists, either:

- create a temporary generic session for this worktree, or
- instruct the user to start via `worktree-fleet session start`

For personal usage, creating a generic session is friendlier.

### `worktree-fleet land`

Safely lands the current non-integration worktree onto the local integration branch. It should:

- create or refresh the current generic session
- run the same safe sync path first
- refuse detached HEAD or running from the integration branch
- refuse dirty current worktree, dirty integration worktree, or active Git operations
- require the integration branch to be an ancestor of the current HEAD
- fast-forward the local integration worktree to the current HEAD
- emit or idempotently confirm the local main-advance event so siblings see the new target
- record a durable `landed` activity event

### `worktree-fleet adapter install|uninstall|list`

Records explicit adapter consent in `~/.worktree-fleet/adapters/<kind>.json`.

- `codex` registers wrapper mode and points at `fleet codex`.
- `claude` records host-managed native lifecycle intent.
- unknown kinds register generic wrapper guidance.

Uninstall removes only the registration file; it does not delete fleet state.

### `worktree-fleet plugin path codex`

Prints the bundled Codex plugin scaffold path. The scaffold can be installed into a Codex plugin marketplace or copied during local development. It provides workflow guidance and must not claim native lifecycle hooks.

### `worktree-fleet gc [--days <n>]`

Prunes main-event JSON files older than the chosen age. It is a maintenance command, not part of normal sync.

### `worktree-fleet session start --agent <kind> -- <command...>`

Generic wrapper:

1. register session
2. start sidecar heartbeat/event watcher
3. run command
4. mark session ended on exit

This is the fallback for any agent without native integration.

### `fleet codex [-- <codex args...>]`

`fleet` is a second package bin, not a shell alias in the user's profile. `fleet codex` is equivalent to:

```sh
worktree-fleet session start --agent codex -- codex <codex args...>
```

Setup and plugins should prefer the package bin. If a host cannot see npm bins, they may install a fleet-managed shim that points at the resolved `fleet` entrypoint. The shim location must be recorded, shown by `doctor`, and removed by uninstall.

## Adapter Details

### Claude Adapter

Install should configure:

- `session_start` from Claude SessionStart
- `before_write` from PreToolUse for Edit/Write/MultiEdit
- `turn_stop` from Stop
- MCP tools for intent/status queries
- slash aliases if supported

Claude can be the first high-fidelity adapter because its lifecycle maps cleanly to the design.

### Codex Adapter

Codex support should have two tiers. Wrapper mode is the realistic launch shape; native mode is aspirational until Codex exposes stable lifecycle hooks or plugin APIs.

1. **Wrapper mode:** use:

```sh
worktree-fleet session start --agent codex -- codex ...
```

2. **Native mode:** if lifecycle hooks or plugin APIs become available, map them to `session_start`, `before_write`, and `turn_stop`.

Wrapper mode still provides:

- registration
- heartbeat
- dirty snapshots
- event watching
- fetch tick participation
- manual `worktree-fleet sync`
- shared `worktree-fleet status`

Wrapper mode may not auto-integrate exactly between model turns unless Codex exposes a safe turn boundary. In that case, the adapter must be honest in `doctor` and status: "manual sync mode."

### Generic Adapter

The generic adapter is important for real usage because it gives an escape hatch for any tool:

```sh
worktree-fleet session start --agent generic-cli -- aider
worktree-fleet session start --agent generic-cli -- cursor-agent
```

Generic mode has fewer early hints but still catches real dirty files through snapshots.

## Hook Installation

The main-advance hook bundle should support:

- `post-merge`
- `post-commit`
- optionally `post-rewrite`

Installer rules:

- never overwrite existing hooks blindly
- insert a managed block with clear markers
- preserve user hook behavior
- be idempotent
- support uninstalling only the managed block
- write the absolute path to the installed `worktree-fleet` binary, because Git hooks may run without the user's interactive shell `PATH`
- pass only the worktree directory (`$PWD`) from shell to the binary; `worktree-fleet hook main-advanced` resolves common dir, branch, and `HEAD` itself and no-ops outside `main`
- log hook failures to fleet state or stderr diagnostics without failing the user's Git operation

Marker example:

```sh
# >>> worktree-fleet managed block >>>
if "/absolute/path/to/worktree-fleet" hook main-advanced "$PWD"; then
  :
else
  status=$?
  "/absolute/path/to/worktree-fleet" hook log-failure main-advanced "$PWD" "$status" || true
fi
# <<< worktree-fleet managed block <<<
```

## Testing Strategy

### Unit Tests

- state path construction
- atomic writes
- stale session sweep
- dirty snapshot parsing
- repo metadata read/write
- path normalization
- intent overlap
- event id creation
- pending target normalization
- divergent target handling
- block notification key computation
- schema migration planning

### Integration Tests With Throwaway Repos

Use temporary Git repos and linked worktrees.

Required scenarios:

- clean local main event integrates into sibling
- dirty non-overlap integrates
- dirty overlap blocks
- staged index blocks
- merge conflict leaves pending and blocked
- active `MERGE_HEAD` blocks before staged-index logic
- local main event before push still integrates exact local SHA
- remote event older than local pending does not replace pending
- remote/local incomparable SHAs produce target divergence
- later SHA containing divergent targets clears divergence
- later SHA that does not contain the existing pending target stays divergent instead of silently replacing pending
- fetching missing candidate objects triggers re-normalization before divergence blocking
- fetch lease allows only one fetch per repo interval
- stale `fetch.lock` with an expired dead owner is recovered
- deleted event files do not lose active pending state
- stale-heartbeat session is swept
- existing Git hooks are preserved during install/uninstall
- installed Git hooks use an absolute `worktree-fleet` binary path and log nonblocking failures
- package exposes both `worktree-fleet` and `fleet` bins
- `worktree-fleet migrate` upgrades older supported state and refuses newer unsupported state
- setup does not install adapters without explicit adapter consent

### Adapter Tests

Claude adapter:

- hook command generation
- MCP tool registration shape
- slash alias install/uninstall
- lazy bootstrap prompt when repo config is missing
- core package install/lookup from plugin

Codex adapter:

- native mode detection if available
- lazy bootstrap prompt when repo config is missing
- wrapper mode registration
- `fleet codex` bin and optional shim generation
- uninstall removes only fleet-managed launcher shims
- manual sync mode reported honestly by doctor

Generic adapter:

- session wrapper starts sidecar
- child process exit marks session ended

## GitHub Readiness Checklist

Before pushing as a public package:

- `README.md` with quickstart for mixed Claude + Codex fleets
- plugin-first quickstart
- `docs/INSTALL.md`
- `docs/ADAPTERS.md`
- `docs/SAFETY.md`
- `docs/TROUBLESHOOTING.md`
- `LICENSE`
- package metadata
- CLI help text
- screenshots or sample `status` output
- test suite running in CI
- release workflow
- changelog
- uninstall documented and tested

## Milestones

### Milestone 0: Local CLI Skeleton

Goal: `worktree-fleet --help` and `fleet --help` work.

- package.json
- `worktree-fleet` and `fleet` bin entries
- TypeScript build
- CLI command routing
- config/state path helpers

### Milestone 1: Core State and Status

Goal: manual sessions can register and appear in status.

- state root
- session read/write
- atomic writes
- locks
- schema versions and migrations
- dirty snapshots
- `session start`
- `status`
- `doctor`
- `migrate`

### Milestone 2: Git Events and Hooks

Goal: local main lands create exact SHA events.

- main-advance hook
- hook installer/uninstaller
- event log
- pending target normalization
- status shows pending targets

### Milestone 3: Safe Sync

Goal: `worktree-fleet sync` safely integrates or blocks.

- active operation detection
- dirty/staged block logic
- incoming file detection
- safe merge
- blocked state
- integration tests

### Milestone 4: Sidecar and Fetch Lease

Goal: generic sessions stay current enough without a fleet daemon.

- heartbeat loop
- event watcher
- per-repo fetch lease
- dirty snapshot refresh tick
- stale session sweep

### Milestone 5: Claude Adapter

Goal: Claude plugin install is enough for Claude sessions to participate.

- SessionStart mapping
- PreToolUse mapping
- Stop mapping
- MCP tools
- slash aliases
- lazy bootstrap prompt
- core package install/lookup from plugin
- doctor checks

### Milestone 6: Codex Adapter

Goal: Codex plugin or launcher install is enough for Codex sessions to participate.

- detect native integration support
- lazy bootstrap prompt
- wrapper/sidecar fallback
- `fleet codex` launcher
- manual sync mode
- doctor checks
- mixed Claude/Codex integration test

### Milestone 7: GitHub Package Polish

Goal: useful to someone who is not the author.

- README quickstart
- install docs
- troubleshooting docs
- CI
- release workflow
- versioned npm package

## First Usable Personal Version

For immediate personal use, do not wait for every adapter feature.

Build this first:

1. `npm exec --package /worktree-fleet -- worktree-fleet setup`
2. `worktree-fleet status`
3. `worktree-fleet sync`
4. `fleet codex` launcher
5. `worktree-fleet session start --agent generic-cli -- <command...>`
6. main-advance hook installer
7. sidecar heartbeat/event watcher
8. dirty snapshots and blocked states
9. lazy "initialize this repo?" prompt in the Claude adapter if feasible

Then run Codex through `fleet codex` and Claude through either the plugin or a generic session wrapper until native adapters are complete. That gives one shared status board and safe manual sync across all worktrees immediately.
