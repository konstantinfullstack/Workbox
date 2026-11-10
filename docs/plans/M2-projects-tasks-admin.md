# M2 plan: Projects, Tasks, minimal admin

- **Status:** Approved 2026-11-04 (all recommendations accepted)
- **Spec reference:** §12 M2, §5 domain model, §9 dashboard

## Scope

**Deliver:** Project CRUD with repository metadata, Task CRUD, a task state machine that writes
audit events, a React dashboard (task cards and statuses, project detail), and a task detail
skeleton.

**Acceptance (spec):**

- Create a project and a task through the API.
- View and edit a task in the dashboard.
- Invalid state transitions are rejected.
- Status history is saved.

**Out of scope:** agents, runs, Git, PRs, connections, CLI, notifications. The dashboard shows
placeholders for runs, branch and PR (filled in M4/M5).

## Decisions

| #   | Decision                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Transition table below. `done` is terminal; `cancelled → backlog` reopens; `blocked`, `changes_requested` and `cancelled` require a reason |
| D2  | Domain services live in a new `packages/services` (`#services`), used by the API now and the worker in M4                                  |
| D3  | `apps/web` gets its own `tsconfig.json` and `vite.config.ts` (browser settings). No separate `package.json` or `node_modules`              |
| D4  | Task dependencies are stored and validated in M2 (same project, no cycles). Scheduling uses them in M6                                     |
| D5  | Projects are archived, never hard-deleted                                                                                                  |
| D6  | Single local user (`user:local`), no auth. The API binds to `127.0.0.1` (see the product direction in PROGRESS.md)                         |
| D7  | Enumerations are stored as `text` + CHECK constraints, generated from one TypeScript list                                                  |
| D8  | REST resources under `/api/v1`. `/health` stays at the root. The API serves the built dashboard at `/`                                     |

## 1. Database (migration `0001_projects_tasks`)

**`projects`:** `id` uuid PK; `name` (1–100); `slug` **unique**, lowercase kebab-case (CHECK);
`description`; `repo_url` nullable, an HTTPS or SSH Git URL with **credentials rejected**;
`default_branch` (default `main`); `status` `active`/`archived`; `next_task_number`; `config` jsonb
(non-secret); `created_at`, `updated_at`.

**`tasks`:** `id` uuid PK; `project_id` FK (`ON DELETE RESTRICT`); `number`, a per-project
sequence, **unique (project_id, number)**; `title` (1–200); `description`; `acceptance_criteria`
jsonb string array; `priority` `low`/`medium`/`high`/`urgent`; `state`; `version` (optimistic
concurrency); `state_changed_at`, `created_at`, `updated_at`. Indexes on `(project_id, state)` and
`(project_id, priority, created_at)`.

**`task_state_transitions`:** `id`, `task_id` FK, `from_state` (null at creation), `to_state`,
`actor`, `reason`, `created_at`. Index on `(task_id, created_at)`.

**`task_dependencies`:** (`task_id`, `depends_on_task_id`) composite PK, a CHECK forbidding
self-dependency, same project only, no cycles (enforced in the service).

## 2. Task state machine (`packages/core`)

| From                | Allowed → to                                  |
| ------------------- | --------------------------------------------- |
| `backlog`           | planning, in_progress, blocked, cancelled     |
| `planning`          | backlog, in_progress, blocked, cancelled      |
| `in_progress`       | verification, blocked, cancelled              |
| `verification`      | ready_for_qa, in_progress, blocked, cancelled |
| `ready_for_qa`      | done, changes_requested, cancelled            |
| `changes_requested` | in_progress, blocked, cancelled               |
| `blocked`           | backlog, planning, in_progress, cancelled     |
| `cancelled`         | backlog                                       |
| `done`              | _(terminal)_                                  |

- Every transition records the actor and an optional reason. A reason is required for `blocked`,
  `changes_requested` and `cancelled`.
- In M2 every transition is manual. M4 adds actor restrictions (some transitions become
  system-only).
- The API returns `allowedTransitions` per task, so the dashboard never duplicates the rules.

## 3. Backend structure

```text
packages/shared/src/        Zod schemas: Project, Task, inputs, states, errors
packages/core/src/domain/   state machine, slug + repo URL validation, cycle check
packages/database/src/schema/  projects, tasks, task_state_transitions, task_dependencies
packages/services/src/      ProjectService, TaskService (#services)
apps/api/src/routes/        projects.ts, tasks.ts (thin HTTP layer)
```

- **One transaction per state change:** lock the task row, validate, update the state and version,
  insert a history row and an audit row. All or nothing.
- **Optimistic concurrency:** `expectedVersion` on PATCH and transitions; a mismatch returns 409.
- **Task numbers** come from `UPDATE projects SET next_task_number = next_task_number + 1 RETURNING`
  inside the create transaction.

## 4. API (`/api/v1`)

| Method | Path                                                     | Purpose                                                 |
| ------ | -------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/projects?status=`                                      | list                                                    |
| POST   | `/projects`                                              | create (slug generated if omitted)                      |
| GET    | `/projects/:idOrSlug`                                    | detail, including task counts by state                  |
| PATCH  | `/projects/:id`                                          | edit                                                    |
| POST   | `/projects/:id/archive`, `/projects/:id/unarchive`       | archive (no hard delete)                                |
| GET    | `/projects/:id/tasks?state=&priority=&q=&limit=&offset=` | list / board                                            |
| POST   | `/projects/:id/tasks`                                    | create (state `backlog` + history row)                  |
| GET    | `/tasks/:id`                                             | detail, including `allowedTransitions` and dependencies |
| PATCH  | `/tasks/:id`                                             | edit fields (not state)                                 |
| POST   | `/tasks/:id/transitions`                                 | `{ to, reason?, expectedVersion? }`                     |
| GET    | `/tasks/:id/history`                                     | status history                                          |

Errors: `400` validation, `404` not found, `409` conflict (slug or version), `422`
`INVALID_TRANSITION`.

## 5. Dashboard (`apps/web`)

React 19, Vite, TypeScript, React Router, TanStack Query and plain CSS. In development, Vite runs
on `:5173` and forwards `/api` to the API. In production, the API serves the built dashboard.

1. **Projects:** list (status, task counts, repo) and a "New project" form.
2. **Project detail:** metadata with edit and archive, a task board and a "New task" form.
   - Board columns: Backlog, Planning, In progress, Verification, Ready for QA, Done.
   - Blocked and changes-requested tasks show as badges. Cancelled tasks are hidden behind a toggle.
   - Cards show the number, title, priority and state, with run, branch and PR placeholders.
3. **Task detail:** editable fields, valid transition buttons only (reason prompt where required),
   a history timeline, and placeholder sections for Runs, Git, Artifacts and QA.

Also: loading, error and empty states, a "last updated" timestamp, a 5 s refresh, and a reload
prompt on 409.

## 6. Tests

- **Unit:** all 81 from→to state pairs, the reason rule, slug rules, repo URL validation
  (including rejected credentials), cycle detection.
- **Integration:**
  - project create/read/update/archive; duplicate slug → 409
  - task create writes the task, a history row and an audit row
  - 20 parallel creates → numbers 1–20
  - valid transition saves everything; invalid → 422 with nothing written
  - two simultaneous transitions → one succeeds, one gets 409; stale version → 409
  - dependency rules; 404s
- **Dashboard** (Testing Library + jsdom): board columns, allowed buttons only, transition request
  and refresh, reason prompt.
- Playwright end-to-end tests are deferred to the M5 vertical slice. M2 uses a manual QA checklist.

## 7. Acceptance criteria

1. Create a project and a task through the API.
2. View and edit a task in the dashboard.
3. Invalid transitions are rejected, with nothing written.
4. Status history is saved and displayed.
5. Every change writes an audit event in the same transaction.
6. Concurrent edits can't silently overwrite each other.
7. The migration applies to an empty DB and upgrades the M1 schema.
8. lint, typecheck, unit and integration tests and build all pass.

## 8. Order of work

1. Shared schemas and state machine (with unit tests)
2. Database schema and migration
3. Services (with integration tests)
4. API routes (with integration tests)
5. Dashboard scaffold and wiring
6. Screens: Projects, then the board, then task detail (with component tests)
7. Docs and ADR-005 (task state machine and audit guarantees)
8. Full verification and report
