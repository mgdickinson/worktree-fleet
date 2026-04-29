---
name: using-git-worktrees
description: Use when starting feature work that needs an isolated Git worktree, before executing implementation plans in a new worktree, or whenever the user says to go in a worktree; fleet-aware replacement for generic git-worktree setup.
---

Use the fleet-aware Git worktree workflow for this repository.

In a worktree-fleet-managed repo, this skill supersedes generic Git worktree guidance. Do not start with raw `git worktree add/remove/move/prune/repair` or `git branch -d/-D`.

First inspect the fleet board:

```sh
worktree-fleet status --refresh-current
```

Then:

1. Inspect existing worktrees with `git worktree list`.
2. Create or enter the requested worktree with normal Git commands.
3. In the destination worktree, run `worktree-fleet status --refresh-current`.
4. If a pending integration target is visible, run `worktree-fleet sync` before editing.
5. If the user named files or areas of work, declare intent with `worktree-fleet intent declare <path...>`.

If a fleet hook blocks the raw Git command, follow the hook message, read the fleet board, and retry only the operation that still makes sense.
