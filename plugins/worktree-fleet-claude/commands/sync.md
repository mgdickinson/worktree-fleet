---
description: Safely catch this worktree up to the latest fleet integration target
allowed-tools: [Bash]
---

# Sync through worktree-fleet

Run:

```sh
worktree-fleet sync
```

Do not manually `git pull`, `git merge main`, or `git rebase main` as a substitute. Fleet owns catch-up because it checks sibling worktree state, dirty overlap, staged changes, active Git operations, missing objects, and divergent targets.

If sync reports blocked, summarize the blocked reason and the files or targets involved.
