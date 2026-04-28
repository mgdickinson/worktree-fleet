---
name: sync
description: Use before manually running git pull, git merge main, or git rebase main; safely catch this worktree up to the latest fleet integration target.
---

Run:

```sh
worktree-fleet sync
```

If it merges a target, continue normally. If it reports a block, stop and explain the reason to the user. Do not bypass staged-index, active-operation, dirty-overlap, missing-object, or divergent-target blocks.

Do not manually `git pull`, `git merge <integration-branch>`, or `git rebase <integration-branch>` as a substitute for fleet sync. Fleet owns catch-up because it checks sibling worktree state and records blocked reasons.
