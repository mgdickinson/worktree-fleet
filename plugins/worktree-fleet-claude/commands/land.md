---
description: Safely land the current worktree branch onto the local integration branch
allowed-tools: [Bash]
---

# Land through worktree-fleet

Run:

```sh
worktree-fleet land
```

Do not manually switch to `main` and merge/rebase as a substitute. Fleet owns landing because it first syncs the current worktree, requires clean current and integration worktrees, fast-forwards the local integration branch, and records the main-advance event for sibling sessions.

If land reports blocked, summarize the blocked reason and the files or worktrees involved.
