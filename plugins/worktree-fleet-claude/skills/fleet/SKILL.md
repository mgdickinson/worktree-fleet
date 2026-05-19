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

For a durable usage trail, including Claude monitor starts, stops, and sidecar errors, run:

```sh
worktree-fleet activity --all --limit 50
```

Use the output as the fleet board. Call out pending main targets, divergent targets, blocked reasons, dirty files, upcoming intent, contention, and recent main events. If no sessions appear, run `worktree-fleet doctor` and report the actionable fix.

When the task involves catching up with the integration branch, prefer:

```sh
worktree-fleet sync
```

Do this before any manual `git pull`, `git merge main`, or `git rebase main` flow. If fleet blocks, surface that block instead of bypassing it with Git.

When the task involves landing a completed worktree back onto the local integration branch, use:

```sh
worktree-fleet land
```

Do this instead of manually switching to `main` and merging the feature branch. Fleet landing requires clean worktrees, fast-forwards the local integration branch, and records the main-advance event.

When creating or switching worktrees, keep fleet visible:

1. Check `worktree-fleet status --refresh-current` before changing worktrees.
2. Create or switch the worktree with normal Git commands.
3. In the destination worktree, run `worktree-fleet status --refresh-current`.
4. If the worktree is behind, run `worktree-fleet sync`.
5. For planned file edits, declare intent with `worktree-fleet intent declare <path...>`.
6. Suggest `worktree-fleet watch` when the user wants to monitor sessions, conflicts, or resolutions live.

The plugin intentionally blocks raw Bash worktree mutations until a recent fleet status/sync/watch check has happened. If that happens, load `worktree-fleet:worktree`, run the fleet check, read the board, then retry only the Git operation that still makes sense.
