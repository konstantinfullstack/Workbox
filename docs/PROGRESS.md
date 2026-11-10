# Workbox Progress

## Current milestone

**M5 — Git workflow and verification: step 2 (run files) implemented on `feat/m5-run-artifacts`
(built on step 1, PR #3).** Plan: [M5](plans/M5-git-verification.md).

## Overview (2026-11-11)

What is built so far. "Your check" = confirmed by the user in the real app.

| #                                      | Area                       | What works                                                                                                                         | Status                |
| -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **M1 — Foundation**                    |                            |                                                                                                                                    |                       |
| 1                                      | Project setup              | Single TypeScript codebase with one root `package.json` (pnpm); API (Fastify), worker (BullMQ), dashboard (React)                  | ✅ Done               |
| 2                                      | Infrastructure             | Your own Postgres 18; Redis via Docker Compose; database migrations                                                                | ✅ Done               |
| 3                                      | Health and CI              | `/health`, readiness checks, API docs at `/docs`; GitHub Actions runs lint, typecheck, tests, build and a secret scan              | ✅ Done               |
| **M2 — Projects and tasks**            |                            |                                                                                                                                    |                       |
| 4                                      | Projects                   | Create, edit and archive projects; default branch per project                                                                      | ✅ Your check         |
| 5                                      | Tasks                      | Create and edit tasks; priority, acceptance criteria, dependencies between tasks                                                   | ✅ Your check         |
| 6                                      | Task statuses              | Backlog → In progress → Verification → Ready for QA → Done, plus Blocked, Changes requested, Cancelled; invalid moves rejected     | ✅ Done               |
| 7                                      | History                    | Every status change recorded (who, when, why) and shown on the task; every change audited                                          | ✅ Done               |
| 8                                      | Dashboard                  | Task board by status, project page, task page                                                                                      | ✅ Your check         |
| **M3 — Accounts and repositories**     |                            |                                                                                                                                    |                       |
| 9                                      | Encrypted token storage    | Tokens encrypted at rest; never shown, logged or given to the agent                                                                | ✅ Done               |
| 10                                     | GitHub and GitLab accounts | Add an account with a token (GitLab self-hosted included) and check that it works                                                  | ✅ GitHub: your check |
| 11                                     | Repository per project     | Pick a repository in the project form; "add account" right there                                                                   | ✅ Your check         |
| 12                                     | Claude Code check          | Workbox checks that Claude Code is installed and signed in on this machine                                                         | ✅ Done               |
| **M4 — Agent runs**                    |                            |                                                                                                                                    |                       |
| 13                                     | Automatic clone            | A linked repository is cloned into `workspaces/<project>` (git-ignored) and kept up to date                                        | ✅ Your check         |
| 14                                     | One working copy           | One normal copy per project, a branch per task (`workbox/<n>-…`)                                                                   | ✅ Your check         |
| 15                                     | Always start fresh         | Every new task starts from the latest `main`/`dev`                                                                                 | ✅ Your check         |
| 16                                     | Agent run                  | Claude Code in restricted mode, time limit, cancel; live timeline, summary, manual QA steps                                        | ✅ Your check         |
| 17                                     | Provider-agnostic          | Claude Code is plugged in through a general agent interface; other agents can be added                                             | ✅ Done               |
| 18                                     | Checks                     | Check commands detected from the repository, confirmed by you, run after the agent; one retry if they fail                         | ✅ Your check         |
| 19                                     | Commit as you              | Your name and GitHub no-reply email, so commits count as your activity                                                             | ✅ Your check         |
| 20                                     | Push and draft PR          | Pushes the task branch and opens a **draft** PR; you review and merge                                                              | ✅ Your check         |
| 21                                     | Failures are safe          | Failing checks → not published; push/PR failure → "retry publishing"; crashed runs recovered on restart                            | ✅ Done               |
| 22                                     | Continue development       | One click runs the next task (changes requested first, then priority, dependencies respected); **stops at Ready for QA**, says why | ✅ Your check         |
| **M5 — Git workflow and verification** |                            |                                                                                                                                    |                       |
| 23                                     | Tasks follow their PR      | PR merged → **Done**; closed → **Changes requested**; checked every 3 min and when the task is opened                              | ✅ Your check (PR #3) |
| 24                                     | Local branch cleanup       | Merged task branches removed from the working copy, only when safe                                                                 | ✅ Done (PR #3)       |
| 25                                     | Saved run files            | Agent transcript, full check output and patch per run; shown on the run; deleted after **7 days**                                  | ✅ Done (PR #4)       |
| 26                                     | Links and check summaries  | Commit and branch links; one result line per check (e.g. "42 passed, 1 failed")                                                    | ⏳ Step 3, next       |
| 27                                     | End-to-end failure tests   | Browser tests proving failures never show up as success                                                                            | ⏳ Step 4             |
| 28                                     | GitLab for real            | One real run with a merge request on a GitLab repository                                                                           | ⏳ Step 5             |
| **Later**                              |                            |                                                                                                                                    |                       |
| 29                                     | M6                         | Telegram notifications, QA approve / request changes, scheduling                                                                   | Not started           |
| 30                                     | M7                         | A second agent, Trello sync                                                                                                        | Not started           |
| 31                                     | Deferred                   | CLI, Docker isolation for agents, sign-in                                                                                          | Not started           |

415 automated tests. Details per step follow below.

## Completed — M5 step 2 (run files, kept 7 days)

- [x] Each run saves, under `<workbox>/artifacts/<runId>/` (git-ignored, owner-only files):
  - `agent-transcript.jsonl`: the agent's raw output for every pass (provider-agnostic: the
    contract's `transcriptPath`; each adapter writes its native format)
  - `checks/<pass>-<step>-<name>.log`: complete check output (the run still stores the last
    16 KB for the timeline)
  - `branch.patch`: the branch's commits (`git format-patch`), never truncated
- [x] **Saved files** on each run: view in the browser (always plain text, `nosniff`, no scripts)
      or download; "Kept until <date>".
- [x] Deleted after `WORKBOX_ARTIFACT_RETENTION_DAYS` (default **7**): files, rows and empty
      folders, by the worker every hour. Migration `0009` adds `run_artifacts`.
- [x] The worker refuses an artifacts folder inside the repository that isn't git-ignored.
- [x] Saving files never fails a run: problems show as a warning on the timeline.

Verification: lint, typecheck, prettier, build, no schema drift; all tests pass (39 files, **415
tests**). New: a real run with a retry saves both check passes, the transcript (with stderr) and an
applicable patch, then everything is purged after 7 days; path escapes are refused; the API serves
files as plain text with safe headers and only under their own run; the dashboard lists them.
Migration `0009` applied to the dev database.

## Completed — M5 step 1 (tasks follow their pull request)

- [x] `ReviewSync` (`#services`): fetches each open PR/MR's state through the code host adapter and
      applies it to the task: merged → Done, closed without merging → Changes requested. Only
      tasks in Ready for QA are moved; history actor `system:review-sync`.
- [x] Worker loop every 3 minutes plus once at startup (`apps/worker/src/review-sync-loop.ts`);
      the task page's refresh uses the same code, so opening a task is enough.
- [x] Merged task branches are deleted from the working copy only when safe
      (`deleteMergedTaskBranch` in `#git`: `workbox/` branch, not checked out, tip == pushed SHA).
      Migration `0008` adds `git_references.local_branch_removed_at`.
- [x] Continue development stops on a task whose PR was closed without merging, instead of
      re-running it on its own.
- [x] Real check on `1_64_modelcollector` (2026-11-10): task #1 (PR #3, merged) moved to Done;
      both merged local branches were removed; the working copy is on `main`.

Verification: lint, typecheck, prettier, build, no schema drift; all tests pass (38 files, **411
tests**), including PR sync tests with the fake GitHub and real git server, and the worker loop.

## Completed — M4 B3 (Continue development)

- [x] **Continue development** card on the project page: one click picks the project's next task
      and starts a run. One click runs one task.
- [x] **Which task:** _Changes requested_ first (finish what is under review), then _Backlog_, each
      by priority (urgent → low), then by number. A task is skipped while a dependency isn't Done;
      dependencies on cancelled tasks are ignored. Planning and hand-moved In progress tasks are
      left alone.
- [x] **Stops at Ready for QA (user decision 2026-11-10: "wait for my review"):** nothing new starts
      while any task is Ready for QA, a run is active, or a task is Blocked. The card always says
      why, with a link to the task:
  - `ready`: "Next up: #5 Add login page"
  - `running`: "Working on #5 …" (after 2 min in the queue: "Is the worker running?")
  - `waiting_for_qa`: "Waiting for your review: #4 …"
  - `blocked`: "#6 … is blocked: Run #2 failed: …" (run it again, or move it to Backlog/Cancelled)
  - `waiting_on_dependencies`: "#7 … is waiting on #4 (in progress)"
  - `not_ready`: the same reasons as the task's Run button (repository, clone, checks, Claude Code,
    worker)
  - `queue_empty`, `archived`
- [x] For a task with requested changes, the reviewer's reason is passed to the agent as the run
      note (the same as typing it on the task page).
- [x] API: `GET /api/v1/projects/:project/continue` (status) and `POST …/continue` (start; 202 with
      the task and run, or 409 `CANNOT_CONTINUE` with the reason). Audited as `project.continued`.
- [x] Code: `pickNextTask` in `#core` (pure), `ContinueService` in `#services`, `ContinueCard` in
      the dashboard.

Verification (2026-11-10): `pnpm lint`, `pnpm typecheck`, all test projects (37 files, **405
tests**), `pnpm build`, `prettier --check` all pass. New tests:

- `packages/core/test/continuation.test.ts`: ordering, dependencies, waiting, empty
- `packages/services/test/continue.int.test.ts`: real DB, git server and stand-in agent: not ready →
  ready → start → running (and stale queue) → Ready for QA stops → changes requested first, with the
  reason as the note → blocked → waiting on dependencies → empty → archived
- `apps/api/test/runs.int.test.ts`: status JSON, 409 `CANNOT_CONTINUE`, OpenAPI route
- `apps/web/test/continue.test.tsx`: the card starts the next task; disabled with the reason while
  waiting for review

## Completed — M4 B2 (checks, push, draft PR)

- [x] **Check detection** (U9): proposed from repository files read through the code host API
      (`package.json` + lockfile for pnpm/yarn/bun/npm, `pyproject.toml`/`requirements.txt`,
      `go.mod`, `Cargo.toml`, `Makefile`). You confirm or edit them on the project's **Checks**
      card; runs require a confirmed configuration, which may be "no automatic checks". Verified
      against GitHub for `1_64_modelcollector`: `pnpm install --frozen-lockfile`, then lint,
      typecheck, test
- [x] **Verification:** checks run in the working copy after the agent (same isolation as the
      agent, `CI=true`, per-command limit); results and output are stored per run. A failure gets
      **one bounded retry**: the agent receives the failure output and may run the check commands
      itself. Spec §5 verification status: pending / running / passed / failed / skipped
- [x] **Commit always, publish only when verified:**
  - checks failing after the retry → the work stays committed locally, never pushed; the task is
    blocked with the reason
  - checks passing → **push** the `workbox/…` branch (token per command, never force) and **open
    or update the draft PR/MR**
  - idempotent: re-runs push to the same branch and update the same PR
- [x] **Commits pushed to the task branch on the server** (e.g. a fix on the PR) are fast-forwarded
      in before the next run; diverged histories are refused, never overwritten
- [x] **Dependency folders** (`node_modules`, `.venv`, …) are excluded locally
      (`.git/info/exclude`) so check setup never ends up in a commit
- [x] **Every new task starts from the latest base branch** (user request after the first merged
      PR): the project's **Default branch** (`main`/`dev`) is checked out, fast-forwarded to the
      server and branched from; PRs target it; after a successful run the copy returns to it
- [x] **First real PR:** task #2's `CONTRIBUTING.md` was published from Workbox as draft PR #2 on
      `1_64_modelcollector` and merged by the user (2026-11-10)
- [x] **`git_references`** (spec §5): branch, pushed commit, PR number/URL/state, last error. PR
      state is refreshed from the host when the task is viewed (at most once a minute). The
      repository's "pull requests" access becomes verified or denied on the first attempt
- [x] **Manual publish / retry** (`POST /tasks/:id/publish`, Git panel button) for commits that
      aren't published yet, e.g. task #2's `4f39ac9`
- [x] PR description: summary, acceptance criteria as a checklist, check results (or a clear "no
      automatic checks"), manual QA steps, run reference
- [x] CI actions bumped to Node 24 releases (`checkout@v7.0.1`, `setup-node@v7.1.0`,
      `pnpm/action-setup@v6.1.0`)

## Completed — M4 B1 (agent runs)

- [x] **`AgentAdapter` contract** (`#agents`, ADR-006) and the **Claude Code adapter**: headless
      stream-json mapped to neutral events; summary and QA steps parsed from the agent's report;
      cost and turns recorded
- [x] **Isolation level (a)** (ADR-004): `--restricted`, `dontAsk`, file tools only (no shell
      until checks exist), push/remote/credential/curl/web tools denied, a minimal environment with
      no Workbox secrets, the prompt via stdin, its own process group, a time limit. Verified with
      real Claude Code: writes inside the worktree work; reading outside it is denied
- [x] **One working copy per project** (ADR-007, revised 2026-11-10 at the user's request):
      `workspaces/<slug>/` switched to the task branch `workbox/<n>-<title>`; no per-task folders.
      Each successful run is **committed locally** as Konstantin Karnaukh
      `<348868008+konstantinfullstack@users.noreply.github.com>`. Runs never discard uncommitted
      work, and never touch folders Workbox doesn't own
- [x] **Runs:** `task_runs` + `run_events` (migration `0005`); run state machine (spec §5); **one
      active run per project** enforced by a partial unique index; worker `runs` queue
      (concurrency 1, never auto-re-executed); crash recovery at startup
- [x] **Task flow by the orchestrator** (`system:orchestrator`, same transaction as the run):
      `in_progress → verification → ready_for_qa`, or `blocked` with the reason (failed, no
      changes, timed out, cancelled, worker restarted)
- [x] **API:** run readiness (reasons), start (optional notes for the agent), list, events, diff,
      cancel
- [x] **Dashboard Runs panel:** readiness reasons, Run / Run again with notes, live timeline,
      Cancel, summary, QA steps, changed files, colour diff viewer
- [x] **Nothing is pushed in B1** (tested: the remote is unchanged and no `workbox/*` branch exists
      on it)
- [x] **B1 checkpoint passed:** the user ran task #2 "Add a CONTRIBUTING.md" on
      `1_64_modelcollector` (25 s, $0.22). The result was migrated to the new layout as commit
      `4f39ac9` on `workbox/2-add-a-contributing-md` (local only)

## Completed — M4 phase A (workspaces)

- [x] Linking a repository queues a clone (`workspaces` queue, separate from health checks and
      probes). The worker makes a bare clone into `workspaces/<slug>/repo.git` inside the project folder
      (git-ignored; `WORKBOX_WORKSPACES_DIR` overrides; user decision 2026-11-05) and records status, commit, size and errors (`workspaces` table,
      migration `0004`)
- [x] **Sync now** (API `POST /projects/:project/repository/sync` and button); duplicate requests
      collapse into one job
- [x] Relinking a different repository re-clones it (stable id stored in `workbox.json`); a rename
      updates the remote; unlinking deletes the clone (only paths inside the root can be deleted)
- [x] Startup recovery: the worker re-queues every linked repository that isn't `ready`, or whose
      clone is recorded at a different location (e.g. after changing `WORKBOX_WORKSPACES_DIR`)
- [x] **Token handling:** a per-command `GIT_ASKPASS` helper reads the token from that git process's
      environment. It's never in `.git/config`, the remote URL, logs or the DB; git output is
      scrubbed; every use is audited (`workspace.sync`)
- [x] **Git isolation:** the user's `~/.gitconfig`, `insteadOf` rewrites, credential helpers and
      hooks are ignored; no credential store is written; https only; no prompts
- [x] **Never committed:** `.workbox/` and `workspaces/` are git-ignored (plus ESLint ignores), and
      the worker refuses a workspaces root inside the repo unless git confirms it is ignored
- [x] Dashboard: "Local clone" row on the repository card (status, `main @ sha`, size, path, error,
      Sync now)
- [x] Tests run against a **real git smart-HTTP server** (`git http-backend` behind Basic auth): clone,
      fetch, re-clone, rename, wrong token, missing repo, credential-free files, config isolation,
      path safety, root guard; plus end-to-end link → Redis → worker → clone

## Completed — M3

- [x] **Vault** (`#vault`, ADR-003):
  - AES-256-GCM with a random IV and authentication tag per secret, bound to its row and provider
    (associated data)
  - keyring with versions and rotation (`pnpm vault:rotate`, all-or-nothing)
  - `Secret` type that never stringifies
  - `pnpm vault:generate-key` writes the key into `.env` without printing it and sets `.env` to `600`
- [x] **Accounts** (connections): any number per provider, each one token for one account on one
      host (github.com, GitHub Enterprise, gitlab.com, self-hosted GitLab over https)
  - tokens verified with the provider before storing; stored encrypted; only a fingerprint returned
  - status follows the spec state machine: connected / degraded / expired / disconnected
  - expiry tracked; warnings for classic/broad/non-expiring tokens and missing GitLab scopes
  - Test, Replace token (re-verifies linked repositories) and Disconnect (deletes the ciphertext)
- [x] **Provider-agnostic `CodeHostAdapter`** (`#integrations`) with **GitHub** and **GitLab**
      adapters: token check, repository list (search, pagination), repository by stable id with
      pull/push access (GitLab access levels mapped); safe error mapping with tokens scrubbed;
      10 s timeouts
- [x] **Project repositories:** one primary repository per project, one project per repository
      (DB-enforced)
  - stored by the provider's stable id, so renames are picked up on verify
  - access statuses: verified / denied / expired / unverified, with the last error
  - PR/MR permission shown as "confirmed on first use" (M5)
- [x] **Claude Code runtime check:** the worker runs `claude --version` + `claude auth status --json`
      (free, non-interactive) via the API → Redis → worker gateway. Personal fields (email, org id)
      discarded; child process gets a minimal environment
- [x] **Audit:** every decryption (`credential.accessed` with purpose), account and repository
      changes, agent-runtime checks, key rotation
- [x] **API** `/api/v1`: `/providers`, `/connections` (+ test/rotate/disconnect/repositories),
      `/projects/:project/repository` (GET/PUT/verify/DELETE),
      `/agent-runtimes/claude-code` (+ check). New error codes → 409/422/502/503
- [x] **Dashboard:**
  - **Repository step in the new-project form** with inline "+ Add account" (provider, optional
    self-hosted URL, password-type token field with step-by-step token instructions and a link)
  - searchable repository picker with pull/push indicators
  - repository card on the project page (verify / change / unlink; expired-token prompt)
  - **Connections** page (accounts by provider, expiry, used-by projects, test/replace/disconnect)
  - agent runtime card
- [x] Migrations `0002_accounts_repositories`, `0003_repository_last_error` (additive; applied to
      the dev DB)
- [x] ADR-003; README, setup guide (master key, connecting repositories, key rotation,
      troubleshooting); `.gitleaks.toml` allowlisting fake tokens in tests

## Completed — M2

- [x] **Domain rules** (`#core`): task state machine (`TASK_TRANSITIONS`), required reasons for
      blocked/changes requested/cancelled, dependency cycle detection, typed `DomainError`
- [x] **Shared contracts** (`#shared`): Zod DTOs for projects, tasks, transitions and lists;
      validation (slug, Git branch, repository URL with **credentials rejected**); error codes
- [x] **Database** (migration `0001_projects_tasks`): `projects`, `tasks`,
      `task_state_transitions`, `task_dependencies`. FKs, unique `(project_id, number)`, CHECK
      constraints generated from the shared enum lists, and a DB-level no-credentials check on
      `repo_url`
- [x] **Domain services** (`#services`, new): `ProjectService` and `TaskService`
  - each state change locks the row and writes the task, history row and audit row in one
    transaction
  - optimistic concurrency (`expectedVersion`)
  - per-project task numbers safe under concurrency
  - lock order is project → task, so concurrent requests can't deadlock
- [x] **REST API** `/api/v1`: project list/get/create/update/archive/unarchive, task
      list/create/get/update, `POST /tasks/:id/transitions` and `GET /tasks/:id/history`.
      Documented in OpenAPI (`/docs`). Domain errors map to 404/409/422 in the shared envelope
- [x] **Dashboard** (`apps/web`, React 19 + Vite + TanStack Query):
  - projects list and create form
  - project detail with edit and archive, a task board and a new-task form
  - task detail: edit, transition buttons from the server's `allowedTransitions` (reason prompt
    where required), history timeline, placeholders for Runs/Git/Artifacts
  - 5 s polling with "Updated Ns ago"; a reload prompt on 409
  - served by the API at `/` after `pnpm build`, with SPA deep-link fallback
- [x] ADR-005 (task state machine, history and audit guarantees)
- [x] README and local setup guide updated

## Completed — M1

- [x] Single-package repo (one root `package.json`); TypeScript 6 strict ESM, ESLint, Prettier,
      Vitest
- [x] Docker Compose: Redis 7, plus optional PostgreSQL 18 (`COMPOSE_PROFILES=postgres`)
- [x] Drizzle migrations with an advisory-locked, idempotent migrator
- [x] `/health` and `/health/ready`, OpenAPI at `/docs`
- [x] BullMQ worker with a `ping` round-trip and graceful shutdown
- [x] Config validation (fails fast, never echoes values) and log redaction
- [x] One set of `DB_*` / `REDIS_*` settings shared by the app, tests and Compose
- [x] CI workflow (`.github/workflows/ci.yml`). **Verified locally only**
- [x] ADR-000 (toolchain/layout) and ADR-001 (Drizzle on PostgreSQL)

## In progress

- None

## Blocked

- **CI on GitHub:** waiting for the user to connect a GitHub remote.
- None. (CI is green on GitHub; the repo is `konstantinfullstack/Workbox`.)

## Decisions

- [ADR-000: Record architecture decisions; repository toolchain](adr/000-record-architecture-decisions-and-toolchain.md)
- [ADR-001: Database access and migrations: Drizzle ORM on PostgreSQL](adr/001-database-access-drizzle.md)
- [ADR-004: Agent isolation, level (a)](adr/004-agent-isolation.md)
- [ADR-005: Task state machine, history and audit guarantees](adr/005-task-state-machine-and-audit.md)
- [ADR-006: Agent adapter contract](adr/006-agent-adapter-contract.md)
- [ADR-007: Worktrees, branches and run concurrency](adr/007-worktrees-and-run-concurrency.md)
- **Product direction (user, 2026-11-04):** personal, single-user, self-hosted tool first.
- **First coding agent: Claude Code**. Provider neutrality stays mandatory: Claude Code sits
  behind the generic `AgentAdapter` contract (ADR-006 in M4), and a second adapter proves
  interchangeability in M7.
- **Roadmap decisions (user, after M2):** GitHub via a fine-grained token first; autopilot stops
  at Ready for QA for a manual check (automatic QA later); CLI deferred until after M4;
  "Continue development" button in M4.
- PostgreSQL over MySQL (ADR-001). Single root package (ADR-000). Discrete `DB_*` / `REDIS_*`
  variables. Local dev uses the user's existing PostgreSQL 18.6 on :5432.
- **M3 decisions:**
  - GitLab in scope
  - repository setup in the project form (U5–U6)
  - one repository per project and one project per repository (D1–D2)
  - tokens per account (D3)
  - master key in `.env` (D4)

  Implementation choices within the plan:
  - Project inputs are now **strict**: unknown fields are rejected, and the pre-M3 `repoUrl`
    field is removed. Repositories come only from accounts. Projects with a previously typed URL
    show "not verified → Connect", with the repo name suggested.
  - Agent-runtime results are stored as a credential-less `claude_code` connection row. They are
    listed separately from code-host accounts.
  - The add-account form is a group, not a nested `<form>`: nesting submitted the project form too
    (found by a dashboard test).

- **M2 decisions D1–D8**, all approved: see the plan. Small implementation choices made within the
  plan:
  - The board shows blocked and changes-requested tasks in a **"Needs attention"** column rather
    than in their previous column, since the previous state isn't stored on the task.
  - Pure validation rules (slug, repo URL, branch name) and the reason-required list live in
    `#shared` instead of `#core`, so the dashboard can show the same hints the server enforces.
    The state machine itself stays in `#core`.
  - Project routes accept a UUID or a slug, which the CLI in M3 will use. Slugs are immutable.
  - `db:generate` runs drizzle-kit with the `@workbox/source` condition. Without it, drizzle-kit
    read stale `dist/` code.

## Verification — M3

Run on 2026-11-04 against the user's PostgreSQL 18.6 and Compose Redis.

| Check                                          | Result                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lint / format / typecheck (server + dashboard) | clean                                                                                                                                                                                        |
| `pnpm test`                                    | 16 files, **234 tests passed**: vault (20), GitHub/GitLab adapters against fake servers, URL rules, Claude probe via stand-in scripts, 19 dashboard tests                                    |
| `pnpm test:integration`                        | 8 files, **72 tests passed**: accounts, repositories, key rotation and agent runtime against a fresh DB; API leak test; API → Redis → worker probe; no-worker timeout                        |
| Leak checks                                    | raw DB rows (`credentials`, `connections`, `audit_logs`, `project_repositories`), every API response and every log line at `trace` level contain no token                                    |
| Migrations                                     | `0002` + `0003` applied to the dev DB; re-run is a no-op; no drift                                                                                                                           |
| Build + compiled API                           | boots with the vault key; a malformed key is refused with "must decode to 32 bytes"                                                                                                          |
| Real providers (fake tokens)                   | api.github.com → 422 `CREDENTIAL_REJECTED` "Bad credentials"; gitlab.com → 422 "401 Unauthorized"; `http://` self-hosted URL → 400; no token in logs                                         |
| Real Claude Code                               | worker reported v2.1.318, signed in (claude.ai)                                                                                                                                              |
| Browser (Chrome)                               | Connections page and agent card; new-project form with Repository step and inline add-account; GitLab self-hosted help; token-settings link points to the custom instance; no console errors |
| gitleaks                                       | only the git-ignored `.env` is flagged (expected); test fakes allowlisted                                                                                                                    |
| Leftover test/smoke DBs                        | none                                                                                                                                                                                         |

**Not yet verified with your real tokens:** linking one of your actual GitHub/GitLab repositories.
See the manual check below.

## Manual check — M3 (with your real accounts)

1. Restart `pnpm dev` (the API now needs `WORKBOX_MASTER_KEY`, already generated in your `.env`).
   Back the key up.
2. **Connections → Check now**: Claude Code should show "Ready".
3. Create a GitHub fine-grained token and/or a GitLab project access token, following the in-app
   instructions.
4. **Projects → New project → Connect a repository → + Add account** → paste the token. You
   should see the account name, and the repository list should load.
5. Pick a repository → **Create project and link repository**. The project page shows ✓ pull, ✓ push.
6. On **Connections**, check the expiry, "Used by", **Test** and **Replace token**.
7. Optional: link the same repo to a second project. It's refused ("already linked").

## Verification — M2

Run on 2026-11-04 against the user's PostgreSQL 18.6 (:5432) and Compose Redis.

| Check                            | Result                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile` | OK                                                                                                                                                                             |
| `pnpm lint` / `format:check`     | 0 problems / all formatted                                                                                                                                                     |
| `pnpm typecheck`                 | server and dashboard pass                                                                                                                                                      |
| `pnpm test`                      | 11 files, **173 tests passed** (unit + 12 dashboard component tests)                                                                                                           |
| `pnpm test:integration`          | 5 files, **42 tests passed**. Each DB file uses a fresh, migrated throwaway database                                                                                           |
| `pnpm db:migrate` (dev DB)       | `0001_projects_tasks` applied (`appliedCount: 1, totalCount: 2`); re-run is a no-op                                                                                            |
| `pnpm db:generate`               | "No schema changes" (no drift)                                                                                                                                                 |
| `pnpm build`                     | server compiled; dashboard bundled to `dist/web` (638 kB JS, 189 kB gzip)                                                                                                      |
| Compiled API on a throwaway DB   | create project/task via `curl`; `in_progress → done` returns 422 with allowed targets; `/`, a deep link and assets serve the dashboard; unknown `/api` path returns a JSON 404 |
| Real browser (Chrome)            | board shows columns and priority badges; task detail → Block → reason required → state, version and history updated; no console errors                                         |
| `pnpm dev` (Vite)                | `:5173` serves the dashboard and forwards `/api` to the API                                                                                                                    |
| gitleaks (v8.28.0)               | no leaks found                                                                                                                                                                 |
| Leftover test databases          | none                                                                                                                                                                           |

Tests covering the acceptance criteria:

| Acceptance criterion                          | Evidence                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Create a project and task through the API     | `apps/api/test/projects-tasks.int.test.ts`                                                                                       |
| View and edit a task in the dashboard         | `apps/web/test/task-page.test.tsx`, `board.test.tsx`, browser check                                                              |
| Invalid transitions rejected, nothing written | 81-pair matrix in `packages/core/test/task-state-machine.test.ts`; "rejects an invalid transition and writes nothing" (services) |
| Status history persisted and displayed        | history assertions in services and API tests; timeline in the dashboard                                                          |
| Audit event with every change, atomically     | audit row assertions, including `trace_id` = `x-request-id`                                                                      |
| No silent lost updates                        | stale-version 409 tests; two concurrent transitions → exactly one wins                                                           |
| Concurrency safety                            | 20 parallel creates → numbers 1–20; concurrent dependency edits can't form a cycle; mixed load doesn't deadlock                  |
| Migration from empty DB                       | `packages/database/test/migrations.int.test.ts` (all 5 tables and key constraints)                                               |

## Manual QA checklist (dashboard)

1. `pnpm dev`, then open http://127.0.0.1:5173.
2. **New project**: name "Demo". Paste `https://user:token@github.com/o/r` as the repository URL.
   An inline error appears and Create stays disabled. Replace it with
   `git@github.com:o/r.git` and create.
3. **New task** ×3 with different priorities. Cards appear in Backlog, urgent first.
4. Open a task, click **Start work**. The state badge, version and history update.
5. Click **Block**. A reason is required. Confirm, and the task moves to "Needs attention" on the
   board.
6. Edit the task in two browser tabs and save in both. The second shows "Someone else changed
   this task" with a **Reload** button.
7. Archive the project. "New task" disappears, and the project shows under "Show archived".

## Known limitations / follow-ups

- The dashboard bundle is 638 kB (React + Zod). Fine locally; consider code-splitting or
  `zod/mini` later.
- No authentication: single-user and loopback-only by design until ADR-002.
- Search uses `ILIKE` without an index. Fine at personal-tool scale.
- No Playwright end-to-end tests yet (planned for the M5 vertical slice).
- Carried over from M1: readiness-failure logs include driver error text; Swagger UI is always on;
  `msgpackr-extract` native build denied.

## Known limitations — M3

- GitHub has no read-only way to confirm pull-request permission (and GitLab none for merge
  requests). It is shown as "confirmed on first use" until M5 creates one.
- The GitHub repository list is filtered locally (the API has no search), capped at 1,000 repos.
- The master key in `.env` is only as safe as the host account. Hosted deployments need a KMS
  (ADR-003).
- Agent-runtime checks need a running worker. Without one, the API answers `WORKER_UNAVAILABLE`
  after 20 s.

## Next action

- **You:** run a task (e.g. with **Continue development**), open it, expand the run and look at
  **Saved files**: open the transcript and a check log, download the patch.
- **Then:** M5 step 3, links and check summaries.
