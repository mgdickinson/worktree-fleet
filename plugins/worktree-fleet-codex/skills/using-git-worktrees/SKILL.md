---
name: using-git-worktrees
description: Use when starting feature work in a Git worktree, creating/opening/removing/pruning worktrees, entering an isolated workspace, coordinating parallel agents, or before raw git worktree commands in a repo that uses worktree-fleet.
---

# Fleet-Aware Git Worktrees

In a worktree-fleet-managed repo, `worktree-fleet` is the coordination layer. Use it before generic Git worktree guidance so sibling sessions, dirty snapshots, pending main updates, and blocked sync state stay visible.

## Required Flow

Before any `git worktree add/remove/move/prune/repair`, run:

```sh
worktree-fleet status --refresh-current
```

For creation:

1. Inspect existing worktrees:

```sh
git worktree list
```

2. Create the worktree with normal Git.
3. Enter the new worktree.
4. Register and refresh its fleet snapshot:

```sh
worktree-fleet status --refresh-current
```

5. If status shows a pending integration target, run:

```sh
worktree-fleet sync
```

6. If the user named files or areas of work, declare intent:

```sh
worktree-fleet intent declare <path...>
```

## Rules

- Do not start with raw worktree mutation before reading the fleet board.
- Do not replace `worktree-fleet sync` with `git pull`, `git merge main`, or `git rebase main`.
- Do not manually switch to the integration branch to merge completed work; run `worktree-fleet land` from the completed worktree.
- Surface blocked reasons, divergent targets, and contended files before proceeding.
- If another worktree skill is loaded, this fleet-aware flow takes precedence in managed repos.
