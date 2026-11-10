# M4 plan: Orchestrator and isolated execution

- **Status:**
  - Phase A: implemented, and verified with the user's repository (2026-11-05).
  - Phases B–D: **approved 2026-11-05**. B1, B2 and B3 implemented.
  - Commit name: "Konstantin Karnaukh", with the account's no-reply email.
  - **Revision 2026-11-10 (user, option A):** no per-task worktree folders. There is one normal
    working copy per project at `workspaces/<slug>/`, switched to the task branch; each successful
    run is committed locally on that branch (ADR-007). Places below that mention `worktrees/` or
    `repo.git` refer to the earlier layout.
  - **B2 details (2026-11-10):**
    - runs require confirmed checks (possibly none)
    - failing checks after the retry keep the commit local, never publish
    - a failed push or PR still completes the run, with a Retry publishing button
    - commits pushed to the branch on GitHub are fast-forwarded in before the next run
- **Spec reference:** §6 task execution, §7 agent abstraction, §11 security, §12 M4
- **Depends on:** M2 (tasks), M3 (accounts, repositories, vault)

## Phase A: Workspaces (automatic clone on link)

**Goal:** when a repository is linked, the worker clones it into a Workbox-owned folder and keeps
it in sync, so agent runs (Phase B) start from a local, up-to-date copy.

### Layout

```text
$WORKBOX_WORKSPACES_DIR                  default: <workbox>/workspaces (git-ignored)
  <project-slug>/
    repo.git/                            bare clone, one per project, fetched before each run
      workbox.json                       which repository this is (provider, host, stable id)
    worktrees/                           Phase B: one checkout per task run
```

The default folder sits inside the Workbox project but is git-ignored (user decision,
2026-11-05), so it's never committed. The worker also refuses any in-repo folder that isn't
ignored. Project slugs are validated (`[a-z0-9-]`), so they're safe as directory names.

### Behaviour

1. **Linking a repository** creates a workspace record (`queued`) and enqueues a `sync-workspace`
   job on a dedicated `workspaces` queue. Long clones never block health checks or probes.
2. **The worker** decrypts the account token (audited) and clones or fetches. It records:
   - `syncing` → `ready` with the default branch's commit and the clone size
   - or `failed` with a safe error message
3. **Sync now** (button and API) re-fetches on demand. Each run (Phase B) also fetches first.
4. **Relinking to a different repository** re-clones; the stable id in `workbox.json` is compared.
   A rename or transfer of the same repository just updates the remote URL.
5. **Unlinking** removes the clone from disk. Only paths inside the workspaces root can be removed.
6. **Crash recovery:** at startup, the worker queues a sync for every linked repository whose
   workspace isn't `ready`. That includes repositories linked before Phase A.

### Token handling (spec §8, §10, §11)

- Tokens are passed to git only through a short-lived `GIT_ASKPASS` helper.
  - The helper script contains no secret; it reads the token from the environment of that one git
    process.
  - The token is **never** written into `.git/config` or the remote URL, and never logged; git
    output is scrubbed.
- Git runs isolated from your personal git setup:
  - `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`: your `~/.gitconfig` and its
    `insteadOf` rules, helpers and hooks are not used
  - no credential helper, so nothing lands in your OS keychain
  - `GIT_TERMINAL_PROMPT=0`
  - only `https` allowed (`http` only for loopback test servers)
- The clone username is `x-access-token` for GitHub and `oauth2` for GitLab; both work with
  personal, project and group tokens.

### Data

New table `workspaces`:

| Column                                      | Notes                                     |
| ------------------------------------------- | ----------------------------------------- |
| `id`                                        | uuid PK                                   |
| `project_repository_id`                     | FK, cascade, unique                       |
| `status`                                    | `queued`, `syncing`, `ready`, `failed`    |
| `path`                                      |                                           |
| `head_sha`                                  | default branch commit after the last sync |
| `size_kb`                                   |                                           |
| `last_synced_at`, `last_error`, `worker_id` |                                           |
| `created_at`, `updated_at`                  |                                           |

The repository DTO gains a `workspace` field.

### Acceptance (Phase A)

1. Linking a repository clones it automatically. The project page shows `cloning…`, then
   `ready · main @ abc1234 · 12 MB · synced 1 min ago`.
2. **Sync now** fetches new commits.
3. The token never appears in `.git/config`, git output, logs or the database (tested against a
   real local git HTTP server that requires the token).
4. The user's personal git config and credential store are not used or modified (tested).
5. Wrong or revoked token → `failed` with "authentication failed", not a hang.
6. Relinking a different repository re-clones; unlinking removes the clone; deletion outside the
   workspaces root is impossible (tested).
7. A worker restart re-queues workspaces that are not `ready`.

## Phases B–D: from task to pull request (end-to-end slice)

**Goal:** press a button on a task (or on the project), and Claude Code implements it in its own
checkout. Workbox then runs your checks, commits as you, pushes a branch and opens a **draft
PR/MR** in the real repository. The task stops at **Ready for QA** for your review.

### Decisions (user, 2026-11-05)

| #   | Decision                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U7  | Commits are **authored as you**, with a `Generated-by: Workbox (Claude Code)` trailer                                                                                                 |
| U8  | **Isolation (a):** Claude Code runs as a local process in the run's worktree with a stripped environment and Claude Code permission rules. A Docker sandbox (ADR-004) is a later step |
| U9  | Check commands are **auto-detected, then confirmed** by you per project (editable); none found means "no automatic checks" and a manual review                                        |
| D5  | Never push to the default branch, never force-push, never merge. Draft PR/MR only                                                                                                     |
| D6  | **One active run per project** (one writer per repository, spec §6), enforced by the database                                                                                         |

### End-to-end flow

```text
Run task / Continue development
  → preparing: fetch, then a worktree at workspaces/<slug>/worktrees/task-<n>
               on branch workbox/<n>-<title-slug>, created from origin/<default>
  → running:   Claude Code in the worktree (headless, streamed events, time and turn limits)
  → verifying: setup + check commands in the worktree, with logs captured
               on failure, the agent gets one bounded retry with the error output
  → Workbox commits (author = you), pushes the branch, opens or updates a draft PR/MR
  → completed: task → ready_for_qa, with summary, changed files, check results, PR link and
               manual QA steps
  on failure:  task → blocked with the reason; run → failed / timed_out / cancelled
Your review: Approve → done (you merge on GitHub/GitLab)
             Request changes → the agent continues on the same branch and PR with your notes
```

### B1: agent runs (no push yet; checkpoint for you to try)

- **`AgentAdapter` contract (ADR-006):** typed events (`started`, `progress`, `tool_call`, `log`,
  `completed`, `failed`), capabilities, cancel. Only `ClaudeCodeAdapter` knows Claude Code's
  flags and output format; the exact headless flags are checked against `claude --help` at
  implementation time.
- **Worktrees (ADR-007):** `git worktree add` from the bare clone; cleaned up after the task is
  done or cancelled.
- **Agent environment:**
  - **No Workbox secrets or tokens** in the agent's environment: only `PATH`, `HOME`, locale, and
    the Claude Code config dir for your existing login
  - working directory = the worktree
  - Claude Code permission rules: edits only inside the worktree; `git push`, `git remote` and
    credential commands denied; network tools limited
- **Limits:** time limit (default 30 min), max turns, cancel (kills the process group). One
  automatic retry for check failures.
- **Data:**
  - `task_runs`: run state machine `queued → preparing → running → verifying → completed`, plus
    `failed` / `cancelled` / `timed_out`; attempt, worker, timings, usage/cost if reported, exit
    reason
  - `run_events`: persisted, redacted logs
  - a partial unique index enforces one active run per project
- **Task transitions by the system actor:** `in_progress` → `verification` → `ready_for_qa`, or
  `blocked` with a reason. M4 adds the actor rules to ADR-005.
- **Dashboard:** **Run** button on the task, live run timeline and logs (polling), Cancel, diff
  summary (files changed).

### B2: checks, commit, push, pull request

- **Check detection** (stored in project config and shown for confirmation):

  | Repo has                              | Proposed                                                                                         |
  | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
  | `package.json` + lockfile             | install via `pnpm`/`npm`/`yarn`, then `lint` / `typecheck` / `test` / `build` scripts if present |
  | `pyproject.toml` / `requirements.txt` | `pip install`, `pytest`, `ruff` if configured                                                    |
  | `go.mod`                              | `go build ./...`, `go test ./...`                                                                |
  | `Cargo.toml`                          | `cargo build`, `cargo test`                                                                      |
  | `Makefile`                            | `make test`, `make lint` if present                                                              |
  | nothing                               | no checks: verification `skipped`, flagged clearly for manual review                             |

- **Commit:**
  - author = your name + your account's **no-reply email**
    (`<id>+<login>@users.noreply.github.com`, `<id>-<username>@users.noreply.gitlab.com`), so it
    counts as your activity without exposing your private address
  - configurable per account
  - message from the task title + agent summary, with a `Generated-by` trailer
- **Push:** Workbox pushes the task branch with the token (same per-command helper as cloning). No
  force-push.
- **PR/MR:**
  - GitHub `POST /repos/{owner}/{repo}/pulls` with `draft: true`; GitLab `POST
/projects/:id/merge_requests` titled `Draft: …`
  - idempotent: an existing PR for the branch is updated, not duplicated
  - stored in `git_references` (spec §5) with status draft/open/merged/closed; repository access
    `reviewRequests` becomes `verified`
- **QA hand-off:** the agent is asked for manual test steps, shown on the task with check results
  and the PR link.

### B3: "Continue development"

- A project button picks the next eligible task (in `backlog` or `changes_requested`,
  dependencies `done`, highest priority, then lowest number) and runs it.
- It **stops at Ready for QA** (U2). The project shows why work stopped: queue empty, task
  blocked, run failed, waiting for your QA, worker offline, cancelled.
- Requires a verified repository, a ready workspace and Claude Code ready. Otherwise the button is
  disabled and says why.
- **Decided 2026-11-10 (user):** nothing new starts while any task is Ready for QA ("wait for my
  review"); requested changes run before new backlog work; one click runs one task.

### Security notes (isolation level a)

With level (a), Claude Code can run the commands it's allowed to **as your OS user** on this
machine. Mitigations:

- no tokens or Workbox secrets in its environment, so it can't push or reach your accounts through
  Workbox
- permission rules
- its own worktree
- time and turn limits
- every command logged

Residual risk: a malicious instruction in a repository could try to read other files your user can
read. That's acceptable for your own repositories; Docker isolation (ADR-004) is the follow-up
before running untrusted repositories.

### Acceptance

1. On `1_64_modelcollector`, a task such as "Add a CONTRIBUTING.md" produces:
   - a `workbox/<n>-…` branch with a commit authored by you
   - a **draft PR** on GitHub, linked on the task
   - the task in **Ready for QA**
2. Check results (or "no checks configured") and the agent's summary and manual QA steps are shown.
3. The token never appears in the agent's environment, logs, run events or the worktree (tested).
4. Cancel and timeout stop the agent and leave the run `cancelled` / `timed_out`, the task
   `blocked` with a reason.
5. Request changes → the agent adds commits to the same branch and PR.
6. A second run on the same project while one is active is refused.
7. **Continue development** runs the next eligible task and stops at QA, with stop reasons shown.
8. Provider-agnostic: no Claude-specific fields in the domain model, schema, API or UI. The adapter
   passes a contract test suite that a second adapter (M7) will also run.
9. lint, typecheck, unit, integration and dashboard tests and build all pass.

### Order of work

B1 (agent runs, with a checkpoint for you to try) → B2 (checks, commit, push, PR) → B3 (Continue
development). ADR-006 (agent adapter contract) and ADR-007 (worktrees) are written as I go;
ADR-004 records isolation level (a) and the Docker follow-up.
