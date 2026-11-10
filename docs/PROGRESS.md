# Workbox Progress

## Current milestone

**M4 B2 — checks, push and draft pull requests: implemented on `feat/m4-b2-push-and-pr`, awaiting your first real publish.**
Plans: [M3](plans/M3-vault-connections.md) · [M2](plans/M2-projects-tasks-admin.md).

| Milestone                                         | Status                                                 |
| ------------------------------------------------- | ------------------------------------------------------ |
| M1 — Foundation                                   | ✅ Done; approved by the user 2026-11-04               |
| M2 — Projects, Tasks, Minimal Admin               | ✅ Done; user checked CRUD in the dashboard 2026-11-04 |
| M3 — Credential Vault, Connections (CLI after M4) | ✅ Implemented, awaiting approval                      |
| M4–M7                                             | Not started                                            |

Nothing is committed yet. The user asked to hold commits for now.

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

- **You:**
  1. start `pnpm dev`
  2. open `1-64-model-collector` → **Checks** → _Detect from repository_ → confirm
  3. on task #2, click **Publish and open draft pull request**
  4. review the PR on GitHub
- **Then:** merge this branch after your OK, and **B3**: "Continue development" (next eligible
  task, stop at Ready for QA).
