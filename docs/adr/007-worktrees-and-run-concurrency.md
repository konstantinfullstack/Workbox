# ADR-007: One working copy per project, a branch per task, run concurrency

- **Status:** Accepted. Revised 2026-11-10 (user chose option A): replaces the original
  "bare clone + one worktree per task" design.
- **Date:** 2026-11-05, revised 2026-11-10

## Context

The first B1 version used a bare clone plus a separate worktree folder per task
(`worktrees/task-<n>`). The user preferred one folder that looks like the real repository. Since
there is already only one active run per project, separate folders bought no parallelism.

## Decision

- **One normal working copy per project:** `workspaces/<slug>/` (git-ignored in the Workbox
  repo). The repository identity lives in `.git/workbox.json`, never in the working tree.
- **A branch per task:** `workbox/<n>-<title-slug>`, created from `origin/<default>` on the first
  run and reused afterwards. A run switches the working copy to its task's branch. The default
  branch is never committed to.
- **Commit at the end of every successful run** on the task branch:
  - author and committer = the user (`WORKBOX_GIT_AUTHOR_NAME`) at the account's no-reply address
    (`<id>+<login>@users.noreply.github.com`, GitLab `<id>-<user>@users.noreply.<host>`)
  - message = task title + agent summary + `Workbox-Task` / `Generated-by` trailers
  - signing and hooks off

  This keeps the working copy clean, so the next task can switch branches safely. Pushing and
  pull requests come in B2.

- **Never lose work:**
  - a run refuses to switch branches while there are uncommitted changes on another branch, and
    says where
  - syncing only fetches (never touches the checkout)
  - a folder is replaced only if it's a Workbox workspace for a different repository with no
    uncommitted changes
  - folders Workbox doesn't recognise are never deleted
- **One active run per project:** a partial unique index on `task_runs(project_id)` for active
  states (one writer per repository, spec §6). The worker runs one job at a time (`runs` queue,
  concurrency 1).
- Run and task state change in the same transaction. The orchestrator acts as
  `system:orchestrator` and never overrides a human change.
- An agent run is never re-executed automatically. After a worker crash, `RunExecutor.recover()`
  fails orphaned runs and re-queues runs that never started.
- Changes shown for review = the branch versus `merge-base(HEAD, origin/<default>)`, i.e. what the
  pull request will show.

## Consequences

- One folder per project that you can open in an editor; no `task-N` folders.
- Runs within a project are strictly sequential (already true).
- If you edit files in the workspace by hand, the next run on another task is refused until you
  commit or discard them.
