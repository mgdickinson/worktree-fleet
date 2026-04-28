---
name: fleet
description: Use whenever working in, creating, switching, listing, syncing, or coordinating Git worktrees, especially when a repo may use worktree-fleet or sibling AI sessions.
---

Before worktree coordination, run:

```sh
worktree-fleet status --refresh-current
```

For a live board, run:

```sh
worktree-fleet watch
```

For a durable usage trail, run:

```sh
worktree-fleet activity
```

Use the output as the fleet board. Call out pending main targets, divergent targets, blocked reasons, dirty files, upcoming intent, contention, and recent main events. If no sessions appear, run `worktree-fleet doctor` and report the actionable fix.

When creating or switching worktrees, keep fleet visible:

1. Check `worktree-fleet status --refresh-current` before changing worktrees.
2. Create or switch the worktree with normal Git commands.
3. In the destination worktree, run `worktree-fleet status --refresh-current`.
4. If the worktree is behind, run `worktree-fleet sync`.
5. For planned file edits, declare intent with `worktree-fleet intent declare <path...>`.
6. Suggest `worktree-fleet watch` when the user wants to monitor sessions, conflicts, or resolutions live.
