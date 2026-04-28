---
name: init
description: Initialize worktree-fleet for the current repository from Claude Code.
---

Run:

```sh
worktree-fleet setup --adapter claude
```

Then run:

```sh
worktree-fleet doctor
worktree-fleet status --refresh-current
```

Explain any doctor failures with the suggested fix. Setup creates `~/.worktree-fleet/`, installs fleet-managed Git hook blocks, enables Git rerere, and records the Claude adapter registration.
