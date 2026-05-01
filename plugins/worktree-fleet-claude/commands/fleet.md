---
description: Show the worktree-fleet board for active sessions, dirty files, intents, pending updates, and blocks
argument-hint: "[extra focus]"
allowed-tools: [Bash]
---

# worktree-fleet board

Run:

```sh
worktree-fleet status --refresh-current
```

Read the output as the fleet board. Call out active sessions, dirty files, upcoming intent, pending integration targets, divergent targets, blocked reasons, and any recent main events.

If `$ARGUMENTS` asks for live monitoring, run:

```sh
worktree-fleet watch
```

If no sessions appear, run:

```sh
worktree-fleet doctor
```

Report the actionable fix.
