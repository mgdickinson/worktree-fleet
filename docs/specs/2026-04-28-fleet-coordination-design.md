# Worktree Fleet Coordination Architecture

**Status:** Design
**Date:** 2026-04-28
**Author:** Matt Dickinson

## Problem

A solo developer runs 5-8 concurrent Claude Code sessions, each in its own git worktree branched from `main`, with 10-40 subagents in flight at peak. The current failure mode:

1. Worktrees diverge from `main` monotonically. Agents do not pull mid-task.
2. When something lands on `main`, sibling worktrees become stale but have no signal.
3. Conflicts surface only at land time, hours later, when divergence is large.
4. Work becomes partially throwaway because the baseline moved out from under it.

## Goals

- Keep every active worktree continuously integrated with `main`.
- Surface conflicts when they are small.
- Give the human dispatcher visibility into the fleet so overlapping work can be re-sequenced before it collides.

## Non-Goals

- **No fleet-wide daemon.** State lives on the filesystem. Coordination happens via flat files and hooks. No process to install, supervise, restart, or debug.
- **No mid-task partial landing.** Agents commit and land at task completion, not before. Frontload-and-land protocols are out of scope.
- **No reconciliation branches.** A third coordination branch is just another worktree with extra steps; not worth the management overhead for ad-hoc fleet work.
- **No autonomous agent yield/wait/serialize.** Agents proceed with their work. The system surfaces signals; the human (via `/fleet`) makes coordination decisions.
- **No cross-worktree merging.** All integration goes through `main`.

## Architecture Overview

Three pieces, all daemon-less.

1. **State directory** at `~/.claude-fleet/`. Plain files. Source of truth for session registration, write sets, and the bus signal.
2. **Per-session MCP server.** Spawned by Claude Code when a session starts. Exposes coordination tools to the agent. Reads and writes the state directory. Runs two background watchers on its own worktree: (a) a file watcher on the bus signal, and (b) a periodic `git fetch` tick to catch remote updates to `origin/main`.
3. **Hooks.** SessionStart, PreToolUse, Stop on the agent side; `post-merge` on the git side of every worktree.

State lives in files. Hooks update files. The MCP server reads and writes files. There is no central process.

```
~/.claude-fleet/
├── sessions/
│   ├── <session_id>.json       # one per active session
│   └── ...
├── intents/
│   ├── <session_id>.json       # current + upcoming write set per session
│   └── ...
└── bus/
    └── main-updated            # touched on every land to main
```

## State Directory

### Per-session state file

Written by the SessionStart hook. Stale files (dead PIDs) are swept by the next session's SessionStart.

```json
{
  "session_id": "uuid",
  "pid": 12345,
  "worktree_path": "/Users/matt/code/iop_crm-feature-x",
  "branch": "feature-x",
  "started_at": "2026-04-28T14:32:00Z",
  "main_pending": false
}
```

`main_pending` is the integration flag. The bus watcher sets it; the next Stop hook clears it after running the merge.

### Per-session intent file

Maintained by PreToolUse hooks (current set, automatic) and optionally by `mcp.declare_intent(...)` (upcoming set, agent-driven).

```json
{
  "session_id": "uuid",
  "current": ["app/models/user.rb", "spec/models/user_spec.rb"],
  "upcoming": ["app/services/auth/", "spec/services/auth/"],
  "updated_at": "2026-04-28T14:42:00Z"
}
```

### Bus signal

A single file at `~/.claude-fleet/bus/main-updated`. Two independent triggers update its mtime:

1. **Local lands** (immediate). A `post-merge` hook installed in each fleet-participating repository (via `core.hooksPath` or each repo's `.git/hooks/`) fires when a merge target is `main`. Worktrees share `.git` with their parent repo, so one hook installation covers all worktrees of that repo. Touches the bus signal.
2. **Remote lands** (within one tick). Each per-session MCP server runs a periodic `git fetch origin` (default: every 30s). If `origin/main`'s SHA changed since the last tick, the MCP server touches the bus signal.

Both triggers write to the same file. Watchers don't need to distinguish between them; the response is the same: integrate at next Stop hook.

Each session's MCP file watcher monitors this file's mtime. On change, the watcher sets `main_pending: true` in its session state. The next Stop hook acts on the flag.

The remote-tracking tick is what makes the design robust to any landing path: local merge + push, GitHub PR merge from another machine, teammate's push, CI auto-merge, anything that moves `origin/main`. The 30s latency is the worst case for remote lands; local lands stay immediate.

## Hooks

| Trigger | What happens |
|---|---|
| **SessionStart** | Sweep stale session files (any with PIDs not running). Register this session. Compute initial state. |
| **PreToolUse** (Edit / Write / MultiEdit) | Append target path to this session's `current` write set. |
| **Stop** (between turns) | If `main_pending`, run `git fetch && git merge --no-edit origin/main`. Surface conflicts to the agent in the next turn's system message. Refresh contention signals from sibling intent files. Clear `main_pending` and this session's `current` write set (so the next turn starts fresh, populated by PreToolUse). |
| **post-merge** (git hook in every worktree) | If the merge was into `main`, touch `~/.claude-fleet/bus/main-updated`. |
| **Fetch tick** (background timer in MCP server) | Every 30s, run `git fetch origin`. If `origin/main` SHA changed, touch `~/.claude-fleet/bus/main-updated`. Safe during agent turns: `fetch` does not modify the working tree. |

`git rerere` is enabled globally (`rerere.enabled=true`, `rerere.autoupdate=true`) so resolved conflict hunks carry across worktrees.

## MCP Tools

Exposed to the agent by the per-session MCP server.

- `declare_intent(files: string[])`. Declares the upcoming write set for this session.
- `release_intent(files: string[])`. Narrows the upcoming set when scope changes.
- `who_else_wants(files: string[])`. Returns sibling sessions whose current or upcoming sets overlap with the given files.
- `fleet_status()`. Returns a snapshot of every active session: branch, distance from `main`, current and upcoming write sets, pending integration flag.

All tools are reads or writes of the state directory. None hold locks. None block.

## Slash Commands

- `/fleet`. Human-readable fleet status: each session, branch, distance from `main`, current write set, contended files.
- `/sync`. Forces a Stop-hook integration cycle now (useful when the agent is stuck or you want immediate alignment).
- `/intents`. Shows this session's current and upcoming write sets.

## Two Coordination Loops

The system runs two independent loops. Both operate on the same state directory but serve different purposes.

### Integration Loop (primary)

This loop solves the "monstrosity" failure mode. It runs continuously, end-to-end, with no human input.

```
land on main
  → post-merge hook touches bus/main-updated
  → all sibling MCP file watchers see mtime change
  → each watcher sets main_pending in its session state
  → at the next Stop hook (between turns):
      git fetch
      git merge --no-edit origin/main
      if conflict:
        leave conflict markers
        inject system message: "main moved, conflicts in <files>, resolve before continuing"
      if clean:
        agent continues, working tree current
      clear main_pending
```

Worst-case staleness equals the duration of the agent's current turn. The system never interrupts a running turn; doing so would shift files under the agent.

### Contention Loop (signal-only)

This loop surfaces overlapping work between live worktrees. It never blocks. Agents always proceed. The signal is informational.

```
PreToolUse fires for path P in session A
  → A's intent file appends P to current set
  → next /fleet read or sibling Stop hook computes overlap with all sibling intents
  → if overlap with session B:
      A's next Stop hook injects: "Sibling has P in its write set"
      /fleet now shows A↔B contended on P
  → human (via /fleet) decides: kill, narrow, stub, or proceed
```

Coordination action is always the human's call. The agent does not yield, wait, or serialize.

## Walkthroughs

### Scenario 1: two worktrees, minor overlap, A lands first

```
t=0       Both agents start. SessionStart writes session.json per worktree.

t=2m      [Optional] Agent A calls mcp.declare_intent(["auth/", "spec/auth/"])
          at task start. Same for B. Overlap detected immediately, before
          either has edited anything. /fleet shows: A↔B contended on auth/.
          Human can intervene now.

t=10m     A's PreToolUse fires for user.rb. Coordinator marks A's current
          write set: [user.rb, ...].

t=12m     B's PreToolUse fires for user.rb. Overlap detected.
          /fleet now shows: A↔B contended on user.rb.
          A's and B's next Stop hooks each inject: "Sibling has user.rb in
          their write set; potential conflict."

t=20m     A finishes, commits, squash-merges to main.

t=20m+0.1s  Post-merge hook on main touches bus/main-updated.

t=20m+0.5s  B's MCP file watcher sees the mtime change. Sets main_pending.

t=21m     B's Stop hook fires (between turns). Sees flag. Runs:
            git fetch && git merge --no-edit origin/main
          Outcomes:
            (a) Clean merge. Working tree updated with A's user.rb. Agent's
                next turn reads current state.
            (b) Conflict on 2-3 lines. Stop hook leaves markers, injects:
                "user.rb has conflicts after A's land. Resolve before continuing."
                Agent resolves on next turn. rerere remembers if seen before.
```

Net: B's conflict (if any) is small, immediate, and resolvable in one turn. Not a multi-hour-later mega-merge.

### Scenario 2: continuous main churn during long task

This is the primary scenario the design exists for.

```
t=0       A starts a 4-hour task.

t=15m     C lands a refactor (local merge to main on this machine).
          Post-merge hook fires the bus immediately.
          A's MCP file watcher sees mtime change. Sets main_pending.
          A is mid-turn (running tools). DO NOT integrate now. Flag waits.

t=18m     A's turn ends. Stop hook fires. Sees flag. Runs:
            git fetch && git merge --no-edit origin/main
          Common case: clean merge. Working tree current.
          Conflict case: small targeted conflict, surfaced to agent in
                         next-turn system message. Agent resolves. Continue.

t=32m, 51m, 1h17m, ...  More lands. Same loop. A integrates many small chunks.

t=4h      A finishes. Squash-lands. Merge to main is trivial because A has
          been continuously current.
```

Avoided: hours of divergence and a multi-hour reconciliation at the end.

### Scenario 3: remote land from another machine

A teammate (or a GitHub PR merge from CI) updates `origin/main` without any local merge happening on this machine. Post-merge hook does not fire here. The fetch tick is what catches this.

```
t=0       A is mid-task in worktree A on this machine.

t=12m+0s  Teammate pushes to origin/main (or GitHub auto-merges a PR).
          No signal yet on this machine.

t=12m+25s A's MCP fetch tick runs (fired by 30s timer). Runs:
            git fetch origin
          Sees origin/main SHA changed since previous tick. Touches the
          bus signal.

t=12m+25s+ε  A's MCP file watcher sees the mtime change. Sets main_pending.

t=14m     A's Stop hook fires (between turns). Sees flag. Runs:
            git fetch && git merge --no-edit origin/main
          Same outcomes as Scenario 2.
```

Worst-case latency for remote lands is one fetch tick (default 30s) plus the time until A's next Stop hook. Local lands stay immediate via post-merge.

## Core Invariant

A worktree is never more than one Stop-hook cycle behind `main`. Worst-case staleness equals the duration of the agent's current turn, typically minutes. Conflicts surface small and early, when the agent still has the cognitive context to resolve them and the human has not sunk additional hours of irrelevant work.

## Failure Modes and Edge Cases

- **Long mid-turn windows.** If an agent's turn runs for hours (deep subagent chain), the `main_pending` flag waits and staleness extends. Mitigation is a workflow norm, not a system mechanism: keep turns bounded. The system never interrupts a running turn.
- **Repeated integration conflicts.** If integration fails on every Stop hook because a worktree's edits keep colliding with new `main` work, the agent gets bombarded with conflict-resolution turns. This is correct behavior, not a bug. It signals two streams of work that should not be parallelized. `/fleet` will make this visible.
- **Land races.** Two worktrees both pushing to `main` simultaneously. Git serializes via `origin/main` HEAD; one push fails non-fast-forward. Loser pulls, re-merges, retries. Standard git behavior. No special handling.
- **Stale session files.** Session ends abnormally (crash, kill -9). The session file is left behind with a dead PID. The next SessionStart sweeps any session file whose PID is not running.
- **Bus file deletion.** If `~/.claude-fleet/bus/main-updated` is missing, watchers stay quiet until the next land creates it. Idempotent; no recovery action needed.
- **rerere mismatches.** rerere only matches identical conflict hunks. Most help comes on mechanical clashes (lockfiles, generated files, imports). Feature-on-feature conflicts will not benefit and require human or agent resolution.
- **Worktree removed externally.** A worktree directory is deleted while a session file still references it. SessionStart's PID sweep handles this when the session ends; in the meantime, `/fleet` may show a path that no longer exists. Acceptable; degrades gracefully.
- **Fetch failure.** If `git fetch origin` fails (network down, auth issue, remote unreachable), the tick logs the error and skips this iteration. Next tick retries. Local lands still broadcast normally via `post-merge`. The system stays useful in offline mode for purely local workflows; remote sync resumes when connectivity returns.
- **Disabled remotes.** Worktrees with no remote configured (rare but possible for local-only experiments) skip the fetch tick. Local broadcast still works. Recommended: keep `origin` configured even for local-only branches so the design is uniform.

## Considered and Rejected

- **Long-running fleet daemon.** Adds a process to manage. Every capability we want (overlap detection, intent tracking, fleet status, bus broadcast) can be served by flat files plus per-session MCP. The daemon was the only piece that did not earn its complexity.
- **Mid-task partial landing / "frontload to unblock."** Most overlap is "both modify the same code," not "A produces, B consumes." Frontloading does not eliminate B's redo work. Plus it breaks squash-on-final-land or requires complex commit-mapping logic.
- **Reconciliation branches.** A third coordination branch is just another worktree with extra steps. Doesn't eliminate the conflict; moves it up a level. Adds a branch to manage per overlapping pair.
- **60-second polling loop running `git merge`.** Would fire mid-turn and shift files under the running agent: stale file context, broken Edit line numbers, failed tool calls. Stop hook is the only safe integration point.
- **Hard file locks.** Agents cannot reliably handle wait/yield. They would deadlock or ignore the lock. Soft advisory signals plus human-in-the-loop dispatch is the right shape.
- **Agent-to-agent negotiation protocols.** Tested against intuition and rejected. Two agents asked to "coordinate" both say "I'll proceed carefully" and produce overlapping work. The human dispatcher is the right point of decision.

## Open Questions

- **Intent decay.** When does an entry leave `current`? Options: clear on commit, on Stop, on session end, or after a TTL. Initial implementation (reflected in the Stop hook spec): clear `current` at the *end* of the Stop hook, after contention signals have been refreshed, so each turn's `current` reflects exactly the files touched that turn. Validate against real usage.
- **Granularity.** File-level overlap is coarse. Two agents editing different functions in the same file are flagged as contended. Could refine to function- or hunk-level later by parsing diffs, but the human dispatcher reading `/fleet` can usually tell at a glance whether overlap is real.
- **Agent prompt integration.** How agents are told to use `declare_intent` and how they should respond to contention signals is a prompt-engineering question, iterable after the plumbing exists.
- **Discoverability of `/fleet`.** Whether the human notices contention in time depends on whether `/fleet` is checked regularly. Could add a Notification hook that pings when overlap appears, but starts as YAGNI; revisit if real overlap goes unnoticed.

## Out of Scope (revisit later if needed)

- Per-repo isolation of the bus signal (currently one global bus at `~/.claude-fleet/bus/main-updated`). False positives across unrelated repos are cheap: integration is a no-op merge when `origin/main` hasn't moved. If multi-repo fleets become noisy, partition the bus per repo.
- Persistent contention history / analytics.
- Auto-rebase variants for branches that prefer a clean linear history.
- Integration with PR-stacking tools (Graphite, etc.).
- Cross-machine fleet coordination.
