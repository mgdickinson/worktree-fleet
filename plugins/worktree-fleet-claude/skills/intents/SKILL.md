---
name: intents
description: Declare or inspect intended file edits for worktree-fleet coordination.
---

When the user names files or directories they plan to edit, declare intent:

```sh
worktree-fleet intent declare <path...>
```

When those files are no longer active, release intent:

```sh
worktree-fleet intent release <path...>
```

For a status board that includes intents, run:

```sh
worktree-fleet status --refresh-current
```
