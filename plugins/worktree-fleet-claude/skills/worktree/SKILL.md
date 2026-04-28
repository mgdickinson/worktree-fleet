---
name: worktree
description: Use when the user asks to create, enter, inspect, clean up, coordinate, or work across Git worktrees.
---

Treat worktree operations as fleet-aware by default.

Before creating, switching, or modifying worktrees, run:

```sh
worktree-fleet status --refresh-current
```

For creation:

1. Inspect existing worktrees with `git worktree list`.
2. Create the new worktree with normal Git commands.
3. In the new worktree, run `worktree-fleet status --refresh-current`.
4. If a pending main target is visible, run `worktree-fleet sync` before starting edits.
5. If the user named files or areas of work, declare intent with `worktree-fleet intent declare <path...>`.

For ongoing coordination:

- Use `worktree-fleet watch` when the user wants a live view.
- Surface blocked reasons, divergent main targets, and contended files before proceeding.
- Do not bypass staged-index, active-operation, dirty-overlap, missing-object, or divergent-target blocks.
