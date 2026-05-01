---
description: Create, enter, switch, remove, prune, or inspect Git worktrees with fleet-aware safety checks
argument-hint: "<worktree request>"
allowed-tools: [Bash]
---

# Fleet-aware worktree workflow

This command supersedes generic Git worktree workflows in fleet-managed repos, including `superpowers:using-git-worktrees`.

The user asked: `$ARGUMENTS`

Before creating, entering, switching, removing, pruning, moving, or repairing worktrees, run:

```sh
worktree-fleet status --refresh-current
git worktree list
```

Then perform the requested worktree operation only after reading the fleet board.

For a newly-created or newly-entered worktree, run inside that worktree:

```sh
worktree-fleet status --refresh-current
```

If a pending integration target is visible, run:

```sh
worktree-fleet sync
```

If the user named files or areas of work, declare intent:

```sh
worktree-fleet intent declare <path...>
```

If a fleet hook blocks a raw Git command, follow the hook message, read the fleet board, and retry only the operation that still makes sense.
