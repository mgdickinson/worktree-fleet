# Worktree Fleet Coordination Architecture

**Status:** Design
**Date:** 2026-04-28
**Author:** Matt Dickinson

## Problem

A solo developer runs 5-8 concurrent AI coding sessions (Claude Code, Codex, or other agents), each in its own git worktree branched from `main`, with 10-40 subagents in flight at peak. The current failure mode:

1. Worktrees diverge from `main` monotonically. Agents do not pull mid-task.
2. When something lands on `main`, sibling worktrees become stale but have no signal.
3. Conflicts surface only at land time, hours later, when divergence is large.
4. Work becomes partially throwaway because the baseline moved out from under it.

## Goals

- Keep every active worktree continuously integrated with `main`.
- Surface conflicts when they are small.
- Make drift impossible to miss: pending and blocked integration targets stay visible until the exact target SHA is integrated.
- Give the human dispatcher visibility into the fleet so overlapping work can be re-sequenced before it collides.
- Preserve per-worktree isolation. The tool must never rely on shared Git scratch state that can be corrupted by many concurrent agents.

## Non-Goals

- **No fleet-wide daemon.** State lives on the filesystem. Coordination happens via flat files and hooks. No process to install, supervise, restart, or debug.
- **No mid-task partial landing.** Agents commit and land at task completion, not before. Frontload-and-land protocols are out of scope.
- **No reconciliation branches.** A third coordination branch is just another worktree with extra steps; not worth the management overhead for ad-hoc fleet work.
- **No autonomous agent yield/wait/serialize.** Agents proceed with their work. The system surfaces signals; the human (via `/fleet` or `worktree-fleet status`) makes coordination decisions.
- **No cross-worktree merging.** All integration goes through `main`.
- **No shared stash/autostash flow.** The stash stack is repo-global enough to be dangerous with dozens of concurrent linked worktrees. Integration must not depend on `git stash push/pop` or any other shared mutable Git scratch area.

## Design Posture

This is a coordination utility for AI jockeys running 50-100 agents in one codebase. It is not a perfect conflict-prevention machine.

The system should be aggressive about making drift and contention visible, but conservative about mutating worktrees. If the safe move is ambiguous, it should stop, preserve the exact target SHA, and tell the agent and human why integration is blocked. A blocked integration is an acceptable result; silently clearing a signal without integrating is not.

## Architecture Overview

Four pieces, all daemon-less.

1. **State directory** at `~/.worktree-fleet/`. Plain files. Source of truth for session registration, write intent, and main-update events.
2. **Core CLI/library.** Agent-agnostic package that owns state files, Git helpers, event normalization, dirty snapshots, fetch leases, and safe integration.
3. **Per-session adapter process.** Spawned or wrapped by each AI coding environment. It exposes coordination tools to the agent, reads and writes the state directory, and runs two background watchers on its own worktree: (a) a file watcher on the main-update event directory, and (b) a periodic `git fetch` tick to catch remote updates to `origin/main`.
4. **Lifecycle hooks.** Agent-side lifecycle events (`session_start`, `before_write`, `turn_stop`, heartbeat) plus a small main-advance git hook bundle (`post-merge`, `post-commit`, optionally `post-rewrite`) on the git side of every worktree.

State lives in files. Hooks and adapters update files. There is no central fleet daemon. Claude and Codex sessions participate in the same fleet by using the same core package and state directory.

```
~/.worktree-fleet/
├── sessions/
│   ├── <session_id>.json       # one per active session
│   └── ...
├── intents/
│   ├── <session_id>.json       # tool hints + upcoming write set per session
│   └── ...
├── adapters/
│   ├── <adapter_kind>.json      # explicit adapter consent + mode
│   └── ...
├── repos/
│   └── <repo_id>/
│       ├── config.json          # integration branch/remote for this repo
│       ├── fetch.lock           # nonblocking per-repo fetch lease
│       ├── last-fetch.json      # last fetch attempt + observed origin/main SHA
│       └── last-main-event      # last local main SHA emitted by hooks
└── bus/
    └── main-events/
        ├── 2026-04-28T14-43-02-123Z-<repo_id>-<sha>.json
        └── ...
```

## State Directory

### Per-session state file

Written by the `session_start` lifecycle and refreshed by the per-session adapter process. Stale files are swept by the next `session_start`.

```json
{
  "session_id": "uuid",
  "agent_kind": "claude-code",
  "adapter": "worktree-fleet-claude",
  "adapter_version": "0.1.0",
  "pid": 12345,
  "worktree_path": "/Users/matt/code/iop_crm-feature-x",
  "repo_id": "sha256-of-git-common-dir",
  "branch": "feature-x",
  "started_at": "2026-04-28T14:32:00Z",
  "heartbeat_at": "2026-04-28T14:42:00Z",
  "dirty_files": ["app/models/user.rb", "spec/models/user_spec.rb"],
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

`repo_id` is derived from `sha256(realpath(git rev-parse --git-common-dir))`, not the remote URL. Fleet state is per-machine and events are only shared among worktrees that share an object database. If cross-clone coordination becomes necessary later, add a separate `remote_id`; do not overload `repo_id`.

`agent_kind` identifies the coding environment (`claude-code`, `codex`, `generic-cli`, etc.). `adapter` identifies the integration package or wrapper that registered the session. Mixed Claude/Codex fleets are normal: contention, dirty snapshots, and main-update events all use the same state model.

`heartbeat_at` is refreshed by the per-session adapter process. Stale session sweeps should treat a file as stale when the PID is gone, or when the heartbeat is old enough that the PID may have been reused by an unrelated process. The default stale heartbeat threshold is 5 minutes and should be configurable.

`dirty_files` is this session's last published Git dirty snapshot. Each session owns its own snapshot; `/fleet` and `fleet_status()` do not run Git commands inside sibling worktrees by default. They read sibling snapshots from the state directory and show `dirty_refreshed_at` so stale data is visible.

`last_absorbed_event_id` is this session's cursor through the append-only main-event log. Watchers and `worktree-fleet sync` skip repo events at or below the cursor and advance it after processing new events.

`integration.pending` is either `null` or the primary unintegrated main-update event for this repo. The event watcher sets it using the pending-target update rules below. The next `turn_stop` hook clears it only after the target commit is actually integrated. If integration is unsafe, `turn_stop` leaves `pending` in place and sets `blocked` with the relevant files and target SHA. `divergent_targets` stores the other maximal advertised main targets when the repo has seen multiple candidates that are incomparable by ancestry. `last_notified_block_key` stores the last `(pending sha, reason, files, divergent targets)` notification so repeated unchanged blocks do not spam the agent context.

### Per-session intent file

Maintained by `before_write` lifecycle hooks when an adapter can observe tool writes (early tool-touch hints, automatic) and optionally by `declare_intent(...)` (upcoming set, agent-driven).

```json
{
  "session_id": "uuid",
  "tool_touched": ["app/models/user.rb", "spec/models/user_spec.rb"],
  "upcoming": ["app/services/auth/", "spec/services/auth/"],
  "updated_at": "2026-04-28T14:42:00Z"
}
```

`tool_touched` is a hint, not the authoritative write set. The owning session refreshes `dirty_files` from Git state:

```
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

The displayed write set is `dirty_files ∪ tool_touched`, which keeps early edit signals while still catching mutations from shell commands, formatters, code generators, package managers, and subagents on the next dirty snapshot refresh.

Dirty snapshots are refreshed at `session_start`, before every `turn_stop` integration attempt, after every `turn_stop` integration attempt, after `before_write` records an edit hint, and on a lightweight heartbeat tick. The heartbeat tick is best-effort and only touches this session's own worktree. If a session is busy or a Git operation is in progress, the previous snapshot remains visible with its `dirty_refreshed_at` timestamp.

All paths in intent and dirty-file state are normalized to repo-relative slash paths. Directory intents match path components below that directory (`auth/` matches `auth/user.rb`, not `authentication.rb`); file intents match exact files.

### Main-update event log

An append-only event directory at `~/.worktree-fleet/bus/main-events/`. Two independent triggers write small event files:

```json
{
  "event_id": "2026-04-28T14-43-02-123Z-<repo_id>-<sha>",
  "repo_id": "sha256-of-git-common-dir",
  "source": "local-main",
  "ref": "main",
  "sha": "abc123",
  "created_at": "2026-04-28T14:43:02.123Z"
}
```

Event filenames use a colon-free UTC timestamp so they remain portable to filesystems such as NTFS and FAT while preserving lexicographic ordering.

1. **Local lands** (immediate). A main-advance hook bundle installed in each fleet-participating repository (via `core.hooksPath` or each repo's `.git/hooks/`) fires after merge, commit, or rewrite operations. If the checked-out branch is `main` and `HEAD` is a new main SHA for this repo, it writes an event containing that SHA. Worktrees share `.git` with their parent repo, so one hook installation covers all worktrees of that repo. Installation must preserve any existing hooks by composing or chaining them, not by overwriting unrelated project hooks.
2. **Remote lands** (within one tick). Each per-session adapter process has a periodic fetch tick, but only one session per repo actually fetches per interval. The tick takes a nonblocking lease at `repos/<repo_id>/fetch.lock`; if another session holds it, this session skips the tick unless the lock is stale. Lock metadata records owner PID, hostname, and acquired time. The default lock TTL is 60 seconds. A contender may steal the lock when `acquired_at + TTL < now` and the same-host owner PID is gone; if the owner cannot be checked reliably, it may steal only after TTL expiry. The winner checks `last-fetch.json` under the same lease. If the last fetch attempt is newer than the interval, it releases the lease without fetching. Otherwise it records the new attempt time, runs `git fetch --no-write-fetch-head origin` (default: every 30s per repo, not per session), and compares `origin/main` to the last observed SHA. If `origin/main`'s SHA changed, the winner writes an event containing the new `origin/main` SHA.

Each session's adapter file watcher monitors the event directory. On a new event whose `repo_id` matches this worktree and whose `event_id` is newer than `last_absorbed_event_id`, the watcher applies the pending-target update rules below and advances the cursor. Events for other repos are ignored. If `pending` advances while `integration.blocked` is already true, `blocked_files` and the blocked reason are recomputed by the next `turn_stop` hook, not by the watcher. The next `turn_stop` hook acts on the stored target SHA, not on a vague "main changed" bit.

Event retention is deliberately simple in v0: the bus is append-only during normal operation, and `worktree-fleet gc --days <n>` can prune old main-event files after sessions have advanced their cursors. At 100 lands/day, the file count is still operationally manageable for early dogfooding.

### Pending-target update rules

Pending targets are ordered by commit ancestry, not by event timestamp. This matters because local `main` and `origin/main` events can arrive out of order: a local land may advertise an unpushed SHA, and a later fetch may observe an older or different remote SHA. In the rules below, "`A` contains `B`" means `B` is an ancestor of `A`.

For a new event `E`, current pending event `P`, and current divergent targets `D`:

```
if E.sha is already contained in this worktree's HEAD:
  ignore E
else:
  candidates = unique events from [P] + D + [E]
  for candidates whose objects are locally available,
    discard any candidate whose sha is contained by HEAD
    discard any candidate whose sha is contained by another candidate

if candidates is empty:
  clear pending
  clear divergent_targets
else if candidates has exactly one event C:
  set pending = C
  clear divergent_targets
  if blocked_reason was "main target divergence":
    leave blocked=true for turn_stop to recompute against C
else:
  choose pending from candidates, preferring the existing pending if it survived,
    otherwise the newest observed event
  set divergent_targets = candidates minus pending
  set blocked = true
  set blocked_reason = "main target divergence"
  surface all candidate shas via status commands and the next turn_stop hook
```

The incomparable case means this machine has seen multiple candidates for "main" that do not contain each other. The fleet should not guess. A human or normal Git workflow must reconcile `main`/`origin/main`; only a later event that contains every outstanding candidate collapses the set to one target and clears `divergent_targets`.

`session_start` uses the same pending-event shape and ancestry rules when it discovers the worktree is already behind at startup. That catch-up event may be synthesized with `source: "session-start-catchup"`; it does not require an existing bus file.

The remote-tracking tick is what makes the design robust to any landing path: local merge + push, GitHub PR merge from another machine, teammate's push, CI auto-merge, anything that moves `origin/main`. The 30s latency is the worst case for detecting remote lands; local lands stay immediate and point at the local `main` commit even before a push completes.

## Agent Adapters

The product boundary is `worktree-fleet`, not a single AI tool. The core is agent-agnostic; integrations are adapters that map each environment's lifecycle and command surface onto the same state model.

### Lifecycle API

Every adapter implements as much of this lifecycle as its host environment supports:

| Core event | Purpose |
|---|---|
| `session_start` | Register the session, identify `agent_kind`, compute `repo_id`, publish initial dirty snapshot, and seed pending integration if already behind. |
| `heartbeat` | Refresh `heartbeat_at`, dirty snapshot, and lightweight contention state. |
| `before_write(paths)` | Record early write hints in `tool_touched`. Best-effort; correctness comes from dirty snapshots. |
| `turn_stop` | Safe integration point. Refresh dirty snapshot, process pending main target, surface blocked state, and refresh dirty snapshot again. |
| `sync_now` | Run the `turn_stop` integration cycle on demand. |
| `declare_intent(files)` / `release_intent(files)` | Maintain upcoming write intent. |
| `fleet_status` | Read published fleet state and render status for the human or agent. |

Adapters can have different fidelity:

- **Full adapter.** Supports `session_start`, `heartbeat`, `before_write`, `turn_stop`, tools, and human commands. This gives early contention hints and automatic safe integration between turns.
- **Lifecycle-only adapter.** Supports `session_start`, `heartbeat`, `turn_stop`, and human commands, but not `before_write`. This still participates correctly because dirty snapshots publish actual Git changes.
- **CLI/manual adapter.** A wrapper or sidecar registers the session and exposes `worktree-fleet sync`, `worktree-fleet status`, and intent commands. This is enough for mixed fleets, but integration cadence depends on the wrapper or human invoking sync points.

### Initial Adapters

- **Claude Code adapter.** Maps Claude Code SessionStart, PreToolUse, and Stop hooks to `session_start`, `before_write`, and `turn_stop`. Exposes agent tools over MCP and human commands as slash commands where available.
- **Codex adapter.** Uses the same core state directory and Git helper layer. Wrapper/sidecar mode is the realistic launch shape: heartbeat, dirty snapshots, event watching, and explicit `worktree-fleet sync/status/intent` commands. Native lifecycle mapping is an upgrade path if the Codex environment exposes stable hooks or plugin APIs. Codex sessions still appear beside Claude sessions in `/fleet` and `worktree-fleet status`.
- **Generic CLI adapter.** Works for any agent launched in a worktree by registering a session, running a heartbeat/event watcher sidecar, and providing command-line sync/status/intent operations.

Mixed fleets are expected. A Claude session and a Codex session in sibling worktrees coordinate through `~/.worktree-fleet/`, not through agent-to-agent protocols.

## Hooks

| Trigger | What happens |
|---|---|
| **session_start** | Sweep stale session files (dead PID or stale heartbeat). Register this session, including `agent_kind`, `adapter`, `repo_id`, branch, current integrated main SHA, and initial `dirty_files`. Compare the branch against the latest known local `main` and fetched `origin/main`; if it is already behind, seed `integration.pending` using the ancestry-based pending-target update rules. |
| **before_write** (if available) | Append target path to this session's `tool_touched` hint set, then refresh this session's `dirty_files` snapshot if Git is available. |
| **turn_stop** | Refresh this session's `dirty_files` from Git. If `integration.pending` exists, try a safe integration of the exact target SHA. If main targets diverged, a Git operation is already in progress, the index is dirty, or dirty files overlap incoming main changes, do not merge; set `integration.blocked` and surface the reason to the agent. Clear `pending` only after a successful merge or when the target is already integrated, and only if no newer pending event replaced it during the merge. Refresh `dirty_files` again before returning. |
| **Main-advance git hooks** (`post-merge`, `post-commit`, optionally `post-rewrite`) | The shell hook passes only the worktree directory (`$PWD`) to the binary. The binary resolves common dir, checked-out branch, and `HEAD` itself. If the checked-out branch is `main` and `HEAD` has advanced to a not-yet-emitted SHA, write a main-update event with `repo_id`, `ref: main`, and the local `main` SHA; otherwise no-op. |
| **Fetch tick** (background timer in adapter process) | Every 30s, try to take the per-repo fetch lease. Lease losers skip. The lease winner enforces the fetch cooldown using `last-fetch.json`, then runs `git fetch --no-write-fetch-head origin` only if the repo has not already fetched within the interval. If `origin/main` SHA changed, write a main-update event with the new SHA. Safe during agent turns: `fetch` does not modify the working tree. |

`git rerere` is enabled globally (`rerere.enabled=true`, `rerere.autoupdate=true`) so resolved conflict hunks carry across worktrees.

### Turn-stop integration algorithm

The `turn_stop` lifecycle may merge main into this worktree, but it must not use the stash stack or other shared Git state.

```
if integration.pending is null:
  refresh dirty state and contention signals
  return

pending_event_id = integration.pending.event_id
target = integration.pending.sha

operation = active Git operation, if any:
  MERGE_HEAD, rebase-merge/, rebase-apply/, CHERRY_PICK_HEAD, or REVERT_HEAD
if operation exists:
  keep integration.pending
  set integration.blocked = true
  set integration.blocked_event_id = pending_event_id
  set integration.blocked_files = unmerged paths, if any
  set integration.blocked_reason = "git operation in progress: <operation>"
  inject only if the blocked target, reason, or file set changed:
    "finish or abort the existing <operation> before fleet integration continues"
  return

normalize_pending_state():
  under the session-file lock:
    reread session state
    normalize candidates from [integration.pending] + integration.divergent_targets:
      contained = candidates whose objects are locally available and whose sha is contained by HEAD
      discard contained candidates
      for remaining candidates whose objects are locally available,
        discard any candidate whose sha is contained by another candidate
    if no candidates remain:
      if contained is non-empty:
        set last_integrated_sha = furthest contained candidate by ancestry
      clear integration.pending
      clear integration.blocked and blocked metadata
      clear integration.divergent_targets
      return "no pending target"
    choose pending from candidates, preferring the existing pending if it survived
    set integration.pending = pending
    set integration.divergent_targets = candidates minus pending
    pending_event_id = integration.pending.event_id
    target = integration.pending.sha

if normalize_pending_state() returned "no pending target":
  return

if target object is missing locally:
  try the per-repo fetch lease
  if lease acquired:
    git fetch --no-write-fetch-head origin
  if target object is still missing:
    keep integration.pending
    set integration.blocked = true
    set integration.blocked_event_id = pending_event_id
    set integration.blocked_reason = "target object unavailable"
    return
  if normalize_pending_state() returned "no pending target":
    return

if divergent_targets is non-empty:
  keep integration.pending
  set integration.blocked = true
  set integration.blocked_event_id = pending_event_id
  set integration.blocked_reason = "main target divergence"
  inject only if the blocked target, reason, or divergent target set changed:
    "multiple main targets were observed and do not contain each other: <shas>"
  return

staged = git diff --cached --name-only
if staged is non-empty:
  keep integration.pending
  set integration.blocked = true
  set integration.blocked_event_id = pending_event_id
  set integration.blocked_files = staged
  set integration.blocked_reason = "index has staged changes; integration requires a clean index"
  inject only if the blocked target, reason, or file set changed
  return

dirty = unstaged working tree + untracked paths
incoming = files changed on main since this branch diverged:
  git diff --name-only HEAD...target

if dirty ∩ incoming is non-empty:
  keep integration.pending
  set integration.blocked = true
  set integration.blocked_event_id = pending_event_id
  set integration.blocked_files = dirty ∩ incoming
  set integration.blocked_reason = "dirty overlap"
  inject only if the blocked target, reason, or file set changed:
    "main moved to <sha>, but these dirty files overlap: <files>"
  return

git merge --no-edit <target>
if merge succeeds or target is already contained:
  under the session-file lock:
    reread session state
    set last_integrated_sha = target
    if integration.pending.event_id == pending_event_id:
      clear integration.pending
      clear integration.blocked and blocked metadata
      clear integration.divergent_targets
    else:
      leave the newer pending event intact
else:
  keep integration.pending
  set integration.blocked = true
  set integration.blocked_event_id = pending_event_id
  set integration.blocked_reason = git error summary
  set integration.blocked_files = conflicted paths
  inject only if the blocked target, reason, or file set changed:
    "main moved to <sha>, integration failed; resolve before continuing"
```

The normal happy path still integrates automatically. The conservative path is explicit blocking, not silent skip. In particular, no `turn_stop` hook may clear `integration.pending` merely because `git merge` was attempted, and a `turn_stop` hook that merged an older event must not overwrite a newer `integration.pending` written while the merge was running.

## Agent Tools

Exposed to the agent by whatever transport the adapter supports. Claude Code can expose these over MCP. Other adapters may expose them through CLI commands, local RPC, or the host agent's native tool system.

- `declare_intent(files: string[])`. Declares the upcoming write set for this session.
- `release_intent(files: string[])`. Narrows the upcoming set when scope changes.
- `who_else_wants(files: string[])`. Returns sibling sessions whose dirty files, tool-touch hints, or upcoming sets overlap with the given files.
- `fleet_status()`. Returns a snapshot of every active session: branch, distance from `main`, dirty files, tool-touch hints, upcoming write sets, pending integration target, divergent target SHAs, and blocked integration state.

All tools are reads or writes of the state directory, plus Git reads of the caller's own worktree when refreshing that session's `dirty_files`. They do not run Git commands in sibling worktrees, block on other agents, or serialize their work.

### State write safety

Flat files are still the source of truth, but writes must be crash-safe and concurrency-tolerant:

- Write JSON to `path.tmp.<pid>.<nonce>`, `fsync` the temp file, atomically `rename()` over the destination, then `fsync` the parent directory.
- Readers tolerate missing or partially written temp files by ignoring files whose names do not match the final schema.
- Updates to a single session's session file, intent file, or repo metadata file use a per-file advisory lock, because adapter processes, lifecycle hooks, tool calls, and human commands can all touch the same state files.
- Event files are immutable after creation. A writer creates a temp file and renames it into `bus/main-events/`.

No fleet coordination state is stored in `git stash`, Git refs, or any other global mutable Git scratch area.

## Human Commands

The core package exposes CLI commands. Adapters may also provide native shortcuts such as Claude slash commands.

| Core CLI | Adapter aliases | Purpose |
|---|---|---|
| `worktree-fleet status` | `/fleet` where slash commands exist | Human-readable fleet status: each session, agent kind, adapter, branch, distance from `main`, dirty files, tool-touch hints, upcoming write set, contended files, pending target SHA, divergent target SHAs, and blocked integration reason. |
| `worktree-fleet sync` | `/sync` where slash commands exist | Forces a `turn_stop` integration cycle now for the current session. Useful when the agent is stuck or you want immediate alignment. |
| `worktree-fleet intents` | `/intents` where slash commands exist | Shows this session's dirty files, tool-touch hints, and upcoming write set. |
| `worktree-fleet intent declare <paths...>` | Adapter tool call when available | Declares upcoming write intent for this session. |
| `worktree-fleet intent release <paths...>` | Adapter tool call when available | Narrows upcoming write intent for this session. |

## Distribution and Install UX

`worktree-fleet` should ship as a GitHub-hosted package with an easy default path and explicit adapter installation.

Recommended v1 packaging:

- **Core package:** `worktree-fleet`, published as an npm package and installable from GitHub. Provides the CLI, state library, Git helper layer, hook installer, and adapter SDK.
- **Claude adapter:** bundled or installable as `worktree-fleet adapter install claude`. Installs Claude lifecycle hooks, MCP tool registration, and optional slash-command aliases.
- **Codex adapter:** bundled or installable as `worktree-fleet adapter install codex`. Installs the best available Codex integration for the local environment. If no native lifecycle hooks are available, installs a wrapper/sidecar flow that still registers the session, heartbeats, dirty snapshots, event watching, and CLI sync/status/intent commands.
- **Generic adapter:** `worktree-fleet session start --agent generic-cli -- <command...>` for any agent process launched in a worktree.

Primary workflow:

```
npm install -g /worktree-fleet
worktree-fleet init
worktree-fleet adapter install claude
worktree-fleet adapter install codex
worktree-fleet doctor
```

`init` creates `~/.worktree-fleet/`, writes default config, enables recommended Git settings such as `rerere`, and installs the main-advance git hook bundle by composing with existing hooks rather than overwriting them.

`doctor` verifies:

- state directory permissions and lock support
- git hook installation and hook chaining
- adapter registration for Claude, Codex, and generic sessions
- `rerere` settings
- fetch lease health
- whether active sessions are heartbeating and publishing dirty snapshots
- whether `/fleet` aliases and `worktree-fleet status` can see the same sessions

`uninstall` must remove only fleet-managed hook blocks and adapter registrations. It must not delete unrelated user hooks, MCP/tool configuration, or state unless explicitly asked.

## Two Coordination Loops

The system runs two independent loops. Both operate on the same state directory but serve different purposes.

### Integration Loop (primary)

This loop solves the "monstrosity" failure mode. In the healthy path it runs continuously, end-to-end, with no human input. When integration is unsafe, it stops with a precise blocked state instead of trying to be clever.

```
land on main
  → main-advance hook writes bus/main-events/<repo_id>-<sha>.json
  → sibling adapter file watchers see the event
  → each matching watcher applies ancestry rules:
      ignore if already contained
      keep only maximal candidates by ancestry
      advance when one candidate contains all others
      block as "main target divergence" while multiple maxima remain
  → at the next turn_stop hook (between turns):
      compute staged files, dirty files, and incoming files from the pending target
      if multiple main targets are divergent:
        do not merge
        keep integration.pending
        set integration.blocked with reason and shas
        inject only when the blocked state changed
      else if a git merge/rebase/cherry-pick/revert is already in progress:
        do not start another merge
        keep integration.pending
        set integration.blocked with operation, files, and sha
        inject only when the blocked state changed
      else if the index has staged files:
        do not merge
        keep integration.pending
        set integration.blocked with files, reason, and sha
        inject only when the blocked state changed
      else if dirty files overlap incoming files:
        do not merge
        keep integration.pending
        set integration.blocked with files, reason, and sha
        inject only when the blocked state changed
      else:
        git merge --no-edit <sha>
        if conflict or merge failure:
          keep integration.pending
          set integration.blocked with files, reason, and sha
          inject only when the blocked state changed
        if clean:
          clear integration.pending only if no newer event replaced it
          agent continues, working tree current
```

Worst-case staleness for a healthy local land equals the duration of the agent's current turn. The system never interrupts a running turn; doing so would shift files under the agent. If integration is blocked, the blocked target SHA and files remain visible until the agent or human resolves the overlap.

### Contention Loop (signal-only)

This loop surfaces overlapping work between live worktrees. It never blocks. Agents always proceed. The signal is informational.

```
before_write fires for path P in session A, if that adapter supports it
  → A's intent file appends P to tool_touched
  → next status read or sibling turn_stop hook computes overlap with sibling published
    dirty_files snapshots, tool_touched hints, and declared upcoming intents
  → if overlap with session B:
      A's next turn_stop hook injects: "Sibling has P in its write set"
      /fleet or worktree-fleet status now shows A↔B contended on P
  → human decides: kill, narrow, stub, or proceed
```

Coordination action is always the human's call. The agent does not yield, wait, or serialize.

## Walkthroughs

### Scenario 1: two worktrees, minor overlap, A lands first

```
t=0       Both agents start. session_start writes session.json per worktree.

t=2m      [Optional] Agent A calls declare_intent(["auth/", "spec/auth/"])
          at task start. Same for B. Overlap detected immediately, before
          either has edited anything. /fleet or worktree-fleet status shows:
          A↔B contended on auth/.
          Human can intervene now.

t=10m     A's before_write fires for user.rb. Coordinator marks A's current
          tool-touch hint: [user.rb, ...]. At turn_stop and status this is
          reconciled with A's real dirty files from Git.

t=12m     B's before_write fires for user.rb. Overlap detected.
          /fleet or worktree-fleet status now shows: A↔B contended on user.rb.
          A's and B's next turn_stop hooks each inject: "Sibling has user.rb in
          their write set; potential conflict."

t=20m     A finishes, commits, squash-merges to main.

t=20m+0.1s  Main-advance hook on main writes a main-update event with A's
            landed SHA.

t=20m+0.5s  B's adapter file watcher sees the event. Ancestry rules advance
            integration.pending to A's landed SHA.

t=21m     B's turn_stop hook fires (between turns). Sees pending target <sha>.
          Computes B's staged files, dirty files, and files changed on main up
          to <sha>.
          Outcomes:
            (a) Clean merge. Working tree updated with A's user.rb. Agent's
                next turn reads current state.
            (b) Dirty overlap on user.rb. turn_stop does not merge. It keeps
                pending=<sha>, sets blocked_files=["user.rb"], and injects:
                "main moved to <sha>, but user.rb has local dirty changes."
                Agent resolves or asks the human to re-sequence. The signal is
                not cleared until <sha> is actually integrated.
            (c) Merge failure despite no predicted overlap. turn_stop leaves
                the failed merge state, keeps pending=<sha>, and injects the
                conflicted paths. rerere remembers if seen before.
```

Net: B's conflict (if any) is small, immediate, and resolvable in one turn. Not a multi-hour-later mega-merge.

### Scenario 2: continuous main churn during long task

This is the primary scenario the design exists for.

```
t=0       A starts a 4-hour task.

t=15m     C lands a refactor (local merge to main on this machine).
          Main-advance hook writes a main-update event immediately.
          A's adapter file watcher sees the event. Ancestry rules advance
          integration.pending to the exact local main SHA.
          A is mid-turn (running tools). DO NOT integrate now. Flag waits.

t=18m     A's turn ends. turn_stop fires. Sees pending target <sha>.
          Requires a clean index, checks dirty-overlap, then merges <sha> only
          if safe.
          Common case: clean merge. Working tree current.
          Dirty-overlap case: explicit blocked state with files and target SHA.
                              Agent or human resolves. The signal remains.
          Conflict case: failed merge is surfaced to agent in next-turn system
                         message. Agent resolves. Continue.

t=32m, 51m, 1h17m, ...  More lands. Same loop. A integrates many small chunks.

t=4h      A finishes. Squash-lands. Merge to main is trivial because A has
          been continuously current.
```

Avoided: hours of divergence and a multi-hour reconciliation at the end.

### Scenario 3: remote land from another machine

A teammate (or a GitHub PR merge from CI) updates `origin/main` without any local main-advance hook firing on this machine. The fetch tick is what catches this.

```
t=0       A is mid-task in worktree A on this machine.

t=12m+0s  Teammate pushes to origin/main (or GitHub auto-merges a PR).
          No signal yet on this machine.

t=12m+25s A's adapter fetch tick runs (fired by 30s timer). Runs:
            acquire repos/<repo_id>/fetch.lock
            check last-fetch.json cooldown
            git fetch --no-write-fetch-head origin
          Sees origin/main SHA changed since previous tick. Writes a
          main-update event with the new SHA.

t=12m+25s+ε  A's adapter file watcher sees the event. Ancestry rules advance
              integration.pending unless the current pending target already
              contains this remote SHA.

t=14m     A's turn_stop fires (between turns). Sees pending target <sha>.
          Requires a clean index, checks dirty overlap, fetches if needed, and
          merges <sha> only if safe.
          Same outcomes as Scenario 2.
```

Worst-case latency for remote lands is one fetch tick (default 30s) plus the time until A's next `turn_stop` hook. Local lands stay immediate via the main-advance hook bundle.

## Core Invariant

In the healthy path, a worktree is never more than one detection interval plus one `turn_stop` cycle behind the latest known `main`. For local lands, detection is immediate and staleness is bounded by the current agent turn. For remote lands, add the fetch tick interval. If integration is blocked, the worktree may remain stale, but the exact target SHA and blocking files remain visible until resolved.

The tool's core promise is not "conflicts disappear." It is "drift does not go silent." Conflicts and dirty overlaps surface small and early, when the agent still has context and the human can re-sequence work before more time is spent on the wrong baseline.

## Failure Modes and Edge Cases

- **Long mid-turn windows.** If an agent's turn runs for hours (deep subagent chain), `integration.pending` waits and staleness extends. Mitigation is a workflow norm, not a system mechanism: keep turns bounded. The system never interrupts a running turn.
- **Repeated integration conflicts.** If integration fails on every `turn_stop` hook because a worktree's edits keep colliding with new `main` work, the blocked state remains visible and the agent is notified only when the blocked target, reason, or file set changes. This is correct behavior, not a bug. It signals two streams of work that should not be parallelized. Fleet status will make this visible.
- **Land races.** Two worktrees both pushing to `main` simultaneously. Git serializes via `origin/main` HEAD; one push fails non-fast-forward. Loser pulls, re-merges, retries. Standard git behavior. No special handling.
- **Stale session files.** Session ends abnormally (crash, kill -9). The session file is left behind. The next `session_start` sweeps any session file whose PID is not running or whose heartbeat is stale enough that PID reuse is plausible.
- **Event deletion.** If old event files are deleted, active sessions that already recorded `integration.pending` keep their target. If a brand-new session starts after deletion, it computes initial state from Git and can still see whether its branch is behind `main` or `origin/main`.
- **Event log growth.** Event retention is intentionally deferred. Even 100 lands/day is roughly 36k small JSON files/year, which is acceptable for the initial filesystem-backed design; add GC only after measured pain.
- **Main target divergence.** If local `main` and `origin/main` advertise incomparable SHAs, the watcher marks `main target divergence` and `turn_stop` does not merge any target. Fleet status shows all candidate SHAs so the human can reconcile normal Git state first. A later event that contains every outstanding target clears the divergence.
- **Git operation in progress.** If a previous merge, rebase, cherry-pick, or revert is in progress, `turn_stop` does not start another merge and does not collapse the state into a generic dirty-index block. It tells the agent to finish or abort the existing operation, then resumes normal integration once `HEAD` contains the pending target or the operation is cleared.
- **Dirty-index block.** A `turn_stop` hook may refuse to merge because the index has staged changes, even when those files do not overlap incoming main changes. This avoids `git merge` failing or consuming staged work. The agent can commit, unstage, or ask the human to re-sequence.
- **Dirty-overlap block.** A `turn_stop` hook may refuse to merge because local dirty files overlap incoming main changes. This is an intentional safety rail. The pending target remains until the agent resolves, commits, narrows, or asks the human to re-sequence the task.
- **rerere mismatches.** rerere only matches identical conflict hunks. Most help comes on mechanical clashes (lockfiles, generated files, imports). Feature-on-feature conflicts will not benefit and require human or agent resolution.
- **Worktree removed externally.** A worktree directory is deleted while a session file still references it. `session_start` PID/heartbeat sweep handles this when the session ends; in the meantime, fleet status may show a path that no longer exists. Acceptable; degrades gracefully.
- **Fetch lease contention.** With dozens of sessions in the same repo, most fetch ticks should lose the nonblocking lease or observe the cooldown and skip. This is expected. The repo still gets at most one fetch per interval, and skipped sessions will observe the event written by the winner.
- **Fetch failure.** If `git fetch --no-write-fetch-head origin` fails (network down, auth issue, remote unreachable, ref lock contention), the tick logs the error and releases the lease. Next tick retries. Local lands still broadcast normally via the main-advance hook bundle. The system stays useful in offline mode for purely local workflows; remote sync resumes when connectivity returns.
- **Disabled remotes.** Worktrees with no remote configured (rare but possible for local-only experiments) skip the fetch tick. Local broadcast still works. Recommended: keep `origin` configured even for local-only branches so the design is uniform.

## Considered and Rejected

- **Long-running fleet daemon.** Adds a process to manage. Every capability we want (overlap detection, intent tracking, fleet status, bus broadcast) can be served by flat files plus per-session adapters. The daemon was the only piece that did not earn its complexity.
- **Mid-task partial landing / "frontload to unblock."** Most overlap is "both modify the same code," not "A produces, B consumes." Frontloading does not eliminate B's redo work. Plus it breaks squash-on-final-land or requires complex commit-mapping logic.
- **Reconciliation branches.** A third coordination branch is just another worktree with extra steps. Doesn't eliminate the conflict; moves it up a level. Adds a branch to manage per overlapping pair.
- **60-second polling loop running `git merge`.** Would fire mid-turn and shift files under the running agent: stale file context, broken edit line numbers, failed tool calls. `turn_stop` is the only safe integration point.
- **Hard work locks.** Agents cannot reliably handle wait/yield for application files. They would deadlock or ignore the lock. Soft advisory signals plus human-in-the-loop dispatch is the right shape. The small advisory locks used for fleet JSON writes are only state-file integrity guards, not work serialization.
- **Agent-to-agent negotiation protocols.** Tested against intuition and rejected. Two agents asked to "coordinate" both say "I'll proceed carefully" and produce overlapping work. The human dispatcher is the right point of decision.

## Open Questions

- **Tool-touch hint decay.** Dirty files are authoritative and disappear when Git is clean. `tool_touched` is only an early warning signal, so it can decay after a short TTL, after the path appears in dirty state, or on session end. Validate against real usage.
- **Granularity.** File-level overlap is coarse. Two agents editing different functions in the same file are flagged as contended. Could refine to function- or hunk-level later by parsing diffs, but the human dispatcher reading `/fleet` can usually tell at a glance whether overlap is real.
- **Agent prompt integration.** How agents are told to use `declare_intent` and how they should respond to contention signals is a prompt-engineering question, iterable after the plumbing exists.
- **Blocked notification cadence.** Initial behavior suppresses repeated block messages unless `pending.sha`, `blocked_reason`, `blocked_files`, or `divergent_targets` changes. Validate whether agents need periodic reminders during long unresolved blocks.
- **Discoverability of fleet status.** Whether the human notices contention in time depends on whether `/fleet` or `worktree-fleet status` is checked regularly. Could add a notification hook that pings when overlap appears, but starts as YAGNI; revisit if real overlap goes unnoticed.

## Out of Scope (revisit later if needed)

- Event retention / garbage collection for old `bus/main-events/` files.
- Persistent contention history / analytics.
- Auto-rebase variants for branches that prefer a clean linear history.
- Integration with PR-stacking tools (Graphite, etc.).
- Cross-machine fleet coordination.
