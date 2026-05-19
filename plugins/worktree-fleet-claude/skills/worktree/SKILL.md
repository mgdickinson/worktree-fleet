---
name: worktree
description: MUST use before creating, removing, pruning, moving, entering, or coordinating Git worktrees, including requests like "go in worktree" or feature work that needs isolation; supersedes generic git-worktree skills in fleet-managed repos.
---

Treat worktree operations as fleet-aware by default.

If another plugin suggests a generic Git worktree workflow, apply this fleet-aware workflow first. In fleet-managed repositories, `worktree-fleet` owns the safety check before raw `git worktree` commands.

Before creating, switching, or modifying worktrees, run:

```sh
worktree-fleet status --refresh-current
```

Claude Bash hooks block `git worktree add/remove/move/prune/repair` and `git branch -d/-D` until a recent fleet status/sync/watch check has happened. This is intentional: worktree lifecycle changes should start from the fleet board, not raw Git alone.

For creation:

1. Inspect existing worktrees with `git worktree list`.
2. Create the new worktree with normal Git commands.
3. In the new worktree, run `worktree-fleet status --refresh-current`.
4. If a pending main target is visible, run `worktree-fleet sync` before starting edits.
5. If the user named files or areas of work, declare intent with `worktree-fleet intent declare <path...>`.

For ongoing coordination:

- Before manually pulling, merging, or rebasing against the integration branch, run `worktree-fleet sync`.
- To land a completed worktree branch onto the local integration branch, run `worktree-fleet land`.
- Use `worktree-fleet watch` when the user wants a live view.
- Surface blocked reasons, divergent main targets, and contended files before proceeding.
- Do not bypass staged-index, active-operation, dirty-overlap, missing-object, or divergent-target blocks.
