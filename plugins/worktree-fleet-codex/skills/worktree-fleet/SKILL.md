---
name: worktree-fleet
description: Use when a user asks Codex to set up, sync, inspect, watch, land, merge back, catch up with main, declare intent, coordinate sibling agents, create or enter Git worktrees, or work in any repo that uses worktree-fleet.
---

# worktree-fleet

Use the local `worktree-fleet` CLI as the source of truth for cross-worktree coordination.

If a repo has a worktree-fleet block in `AGENTS.md`, follow it even when another worktree skill also triggers.

## Workflow

1. If the user asks to initialize fleet for a repo, run:

```sh
worktree-fleet setup --adapter codex
```

2. Before substantial edits in a fleet-managed repo, refresh the current session:

```sh
worktree-fleet status --refresh-current
```

3. When the user asks to catch up with main or before a handoff, run:

```sh
worktree-fleet sync
```

4. When the user asks to land completed work back onto the local integration branch, run:

```sh
worktree-fleet land
```

5. If the user names files they plan to edit, publish intent:

```sh
worktree-fleet intent declare <path...>
```

6. Before creating, removing, pruning, or entering Git worktrees, also use the `using-git-worktrees` skill from this plugin and start with:

```sh
worktree-fleet status --refresh-current
```

Release intent after the work is no longer active:

```sh
worktree-fleet intent release <path...>
```

## Interpreting Results

- If `sync` says it merged a SHA, continue normally.
- If `sync` reports `dirty overlap`, ask the user whether to resolve local edits or handle the main update manually.
- If `sync` reports staged changes or an active Git operation, do not change integration state; finish or abort the Git operation first.
- If status shows `divergent` targets, surface the candidate SHAs and ask for human reconciliation.

## Host Integration Notes

This plugin supplies Codex workflow guidance. Automatic per-turn lifecycle hooks require a native Codex plugin surface; until that exists, the supported launch path is:

```sh
fleet codex
```
