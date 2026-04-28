---
name: sync
description: Safely catch this worktree up to the latest fleet main target.
---

Run:

```sh
worktree-fleet sync
```

If it merges a target, continue normally. If it reports a block, stop and explain the reason to the user. Do not bypass staged-index, active-operation, dirty-overlap, missing-object, or divergent-target blocks.
