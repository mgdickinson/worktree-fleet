---
description: Declare or inspect intended file edits for worktree-fleet coordination
argument-hint: "declare <path...> | release <path...> | status"
allowed-tools: [Bash]
---

# worktree-fleet intents

The user asked: `$ARGUMENTS`

If declaring intent, run:

```sh
worktree-fleet intent declare <path...>
```

If releasing intent, run:

```sh
worktree-fleet intent release <path...>
```

If inspecting intent, run:

```sh
worktree-fleet status --refresh-current
```

Use intents to surface likely file contention before sibling worktrees collide.
