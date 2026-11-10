# ADR-004: Agent isolation, level (a): restricted local process

- **Status:** Accepted for M4. Docker sandbox is a planned follow-up.
- **Date:** 2026-11-05
- **Decision by:** the user ("let's start from (a)")

## Context

Spec §11 asks for disposable containers with resource and network limits for untrusted code.
Workbox is currently a personal tool running agents on the user's own repositories. Running Claude
Code inside Docker would require a separate login inside the container. The user chose to start
with a restricted local process.

## Decision

Claude Code runs as a **local child process** in the run's own git worktree, with:

1. **No Workbox secrets.** The environment is reduced to `PATH`, `HOME`, user and locale
   variables, `TMPDIR`, the XDG directories and `CLAUDE_CONFIG_DIR` (so it finds the user's own
   login). No tokens, master key or database credentials. This is tested.
2. **`--restricted`:** only the tools Workbox names (`Read, Edit, Write, Glob, Grep`; `Bash` only
   when check commands are configured, and then only those commands). The user's and project's
   Claude settings are ignored, and file tools are confined to the working directory. Verified
   with real Claude Code: writing inside the worktree works, and reading `/etc/hostname` was
   denied.
3. **`--permission-mode dontAsk`:** anything not pre-allowed is denied, never prompted.
   `git push/remote/config/credential`, `curl`, `wget`, `WebFetch` and `WebSearch` are explicitly
   denied.
4. **Its own process group:** cancel and timeout kill everything it started. A time limit is
   configurable (`WORKBOX_RUN_TIMEOUT_MINUTES`, default 30).
5. **The prompt goes through stdin**, so task text isn't visible in the process list.
6. **Workbox, not the agent, pushes** (M5), using tokens the agent never receives.

## Consequences

- Residual risk: within its allowed tools the agent acts as the user's OS account. Repository
  content is untrusted input (prompt injection); the denied tools and confinement limit the impact.
  This is acceptable for the user's own repositories.
- **Before running untrusted repositories:** a Docker sandbox (non-root, no network except the
  model API, resource limits, no Docker socket) behind the same `AgentAdapter` contract.
