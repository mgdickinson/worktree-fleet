---
description: Initialize worktree-fleet for this repository and Claude Code
allowed-tools: [Bash]
---

# Initialize worktree-fleet

Run:

```sh
worktree-fleet setup --adapter claude
worktree-fleet doctor
worktree-fleet status --refresh-current
```

Explain any doctor failures with their suggested fix. Setup creates local fleet state, installs fleet-managed Git hooks, enables Git rerere, and records the Claude adapter registration.
