# Local setup and operations

## 1. Configure

```bash
cp .env.example .env
```

`.env` is git-ignored. Every value in `.env.example` is a placeholder for a loopback-only
development stack.

### One set of settings

Each connection setting is defined once. The app, the tests and Docker Compose all read it:

| Variable                                                  | Meaning                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | The PostgreSQL server and database Workbox uses               |
| `DB_TEST_NAME`                                            | Database for integration tests (default `workbox_test`)       |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`              | The Redis server                                              |
| `COMPOSE_PROFILES`                                        | `postgres` = Compose also runs PostgreSQL; empty = Redis only |

### Option A: bundled PostgreSQL (default)

Keep `.env.example` as is. Compose creates a PostgreSQL container using `DB_USER`,
`DB_PASSWORD` and `DB_NAME` and publishes it on `127.0.0.1:DB_PORT` (default `55432`, which avoids
clashing with a local PostgreSQL on 5432).

`DB_USER`, `DB_PASSWORD` and `DB_NAME` are applied only when the data volume is first created.
After changing them, recreate the volume with `docker compose down -v`. That **deletes the data**.

### Option B: your own PostgreSQL

Set `COMPOSE_PROFILES=` (empty) and point the `DB_*` variables at your server, for example
`DB_PORT=5432`. Create `DB_NAME` and `DB_TEST_NAME` on that server. The test user needs
`CREATEDB`, because the migration test creates and drops temporary databases. Compose then runs
only Redis.

### Vault master key

```bash
pnpm vault:generate-key
```

This writes a random 32-byte `WORKBOX_MASTER_KEY` into `.env`, sets the file to owner-only (`600`)
and never prints the key. It refuses to overwrite an existing key, because replacing it would make
every stored token unreadable. The API won't start without a valid key.

**Back the key up** (e.g. in a password manager), separately from database backups. Losing it means
re-entering your GitHub/GitLab tokens; nothing else is lost.

## 2. Start infrastructure

```bash
pnpm infra:up        # docker compose up -d --wait
docker compose ps    # both services should be "healthy"
```

With the bundled PostgreSQL, `infra/docker/postgres/init/01-create-test-database.sh` creates
`DB_TEST_NAME` the first time an empty volume starts.

## 3. Migrate

```bash
pnpm db:migrate
```

- Migrations are plain SQL in `packages/database/migrations/` and are committed.
- `db:migrate` takes a PostgreSQL advisory lock, so concurrent runs serialise safely.
- Re-running is a no-op. Applied migrations are tracked in `drizzle.__drizzle_migrations`.
- `drizzle.config.ts` at the repository root points drizzle-kit at the schema and migrations.
- To change the schema, edit `packages/database/src/schema/*.ts` and run
  `pnpm db:generate --name <description>`. Review the SQL and commit it. Never edit a migration
  that has been merged. CI fails if the schema and the committed migrations disagree.

## 4. Run

```bash
pnpm dev                         # API + worker + dashboard (Vite on :5173), with reload
pnpm dev:api                     # just the API (or: pnpm dev:worker)
pnpm build && pnpm start:api      # compiled API    (node dist/apps/api/src/server.js)
pnpm build && pnpm start:worker   # compiled worker (node dist/apps/worker/src/main.js)
```

| Endpoint            | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `GET /health`       | Liveness. 200 while the process is up. No dependency calls |
| `GET /health/ready` | Readiness. 200 if PostgreSQL and Redis respond, else 503   |
| `GET /docs`         | Swagger UI (`/docs/json` for the OpenAPI document)         |
| `/api/v1/...`       | Projects and tasks REST API (see `/docs`)                  |
| `/` (built only)    | Dashboard, after `pnpm build`. In dev use `:5173`          |

Every response carries an `x-request-id` header. A well-formed incoming `x-request-id` is
propagated, so callers can correlate logs.

### Dashboard

- **Dev:** `pnpm dev` starts Vite on `http://127.0.0.1:5173`. It forwards `/api`, `/health` and
  `/docs` to the API (`API_HOST`/`API_PORT` from `.env`), so no CORS setup is needed.
- **Built:** `pnpm build` writes the bundle to `dist/web/`, and `pnpm start:api` serves it at `/`.
  Deep links like `/tasks/<id>` fall back to `index.html`.
- There is no login. Workbox is single-user and binds to `127.0.0.1` (see
  `docs/plans/M2-projects-tasks-admin.md`, D6).

### Try the API

```bash
curl -s -XPOST localhost:3000/api/v1/projects -H 'content-type: application/json' \
  -d '{"name":"Demo","repoUrl":"git@github.com:org/demo.git"}'
curl -s -XPOST localhost:3000/api/v1/projects/demo/tasks -H 'content-type: application/json' \
  -d '{"title":"Add /health endpoint","acceptanceCriteria":["returns 200"]}'
curl -s -XPOST localhost:3000/api/v1/tasks/<task-id>/transitions -H 'content-type: application/json' \
  -d '{"to":"in_progress","expectedVersion":1}'
```

### Connecting repositories

1. Create a token on the code host (the dashboard shows the exact steps and a link):
   - **GitHub:** a fine-grained personal access token, one per owner (your user or an org).
     Repository access "Only select repositories". Permissions: Contents R/W, Pull requests R/W,
     Metadata R.
   - **GitLab:** preferably a project (or group) access token. Role Developer. Scopes `api`,
     `read_repository`, `write_repository`. Self-hosted instances work: tick "Self-hosted" and
     enter the instance URL (https only).
2. In the dashboard, create or open a project → **Repository** → **+ Add account** → paste the
   token. Workbox verifies it with the provider before saving it encrypted.
3. Pick the repository from the list. Workbox records its stable id, URLs, default branch and the
   verified pull/push access. Pull/merge-request permission is confirmed on first use (M5).

Accounts are reusable: the **Connections** page lists them with status, expiry and the projects
using each one. **Replace token** there re-verifies every linked project. **Disconnect** deletes
the token. M3 only _reads_ from code hosts; nothing is pushed.

The **Agent runtime** card asks the worker to run `claude --version` and `claude auth status`.
Workbox uses your existing Claude Code login and never copies it. Set `CLAUDE_CODE_COMMAND` if
`claude` isn't on the worker's PATH.

### Local clones (workspaces)

When you link a repository, the worker clones it automatically into
`WORKBOX_WORKSPACES_DIR`. The default is the git-ignored `workspaces/` folder in the Workbox
project:

```text
workbox/workspaces/<project-slug>/    a normal working copy; fetched on "Sync now" and before runs
```

To use another folder, set `WORKBOX_WORKSPACES_DIR` (absolute, `~/…`, or relative to the project
folder). After a change, the worker re-syncs every clone into the new location at startup.

- **Progress** shows on the project's Repository card: Queued → Cloning → Ready, with the commit,
  size and path, or Failed with the reason. **Sync now** fetches new commits.
- **Tokens** are given to git only for each clone or fetch, through a temporary prompt helper. They
  are never written to `.git/config`, the remote URL or logs. Git ignores your personal
  `~/.gitconfig` and credential helpers while doing this.
- **Agent runs** switch this copy to the task's `workbox/<n>-…` branch, then commit the result
  there as you (`WORKBOX_GIT_AUTHOR_NAME` + the account's no-reply email). You can open the folder
  in your editor to look around, but do your own coding in your own clone. Workbox won't start a
  run while the copy has uncommitted changes on another branch, and it never discards them.
- **Unlinking** deletes the clone. Linking a different repository replaces it. A rename of the same
  repository just updates the remote.
- **Recovery:** at startup the worker re-queues any linked repository that isn't cloned yet.
- **The folder never gets committed.** `workspaces/` is in `.gitignore`. Any other folder you
  choose inside the Workbox repo must be git-ignored too, or the worker refuses to start.

### Checks and publishing

- **Checks:** on the project page, **Checks → Detect from repository** proposes commands from your
  repo (e.g. `pnpm install --frozen-lockfile`, then lint, typecheck, test). Edit or confirm them.
  Runs need this decision once; "no automatic checks" is a valid choice.
- **After each run:**
  1. the checks run in the working copy; a failure gives the agent one retry with the error
     output
  2. Workbox commits as you
  3. if the checks pass, it pushes the `workbox/…` branch and opens or updates a **draft** pull
     request (GitHub) or merge request (GitLab)
  4. you review, mark it ready and merge it yourself; Workbox never merges
- **Retry:** if pushing or opening the PR fails (e.g. the token lacks _Pull requests: write_), the
  task's **Git** panel shows why, with a **Retry publishing** button.
- **Fixes on the PR branch:** if you push a fix there yourself, the next run starts from it.

### Rotating the master key

1. Move the current key to `WORKBOX_PREVIOUS_MASTER_KEYS=1:<old base64>`.
2. Clear `WORKBOX_MASTER_KEY`, run `pnpm vault:generate-key`, and set
   `WORKBOX_MASTER_KEY_VERSION=2`.
3. Run `pnpm vault:rotate`. It re-encrypts all tokens in one transaction.
4. Remove `WORKBOX_PREVIOUS_MASTER_KEYS` and restart the API.

## 5. Test

```bash
pnpm test               # unit + dashboard component tests; no infrastructure needed
pnpm test:integration   # requires `pnpm infra:up`
```

Integration tests use the same `DB_*` / `REDIS_*` settings but connect to `DB_TEST_NAME`, never
`DB_NAME`. Values already exported in the shell (as in CI) take precedence over `.env`.

- Each database test file creates its own throwaway `workbox_it_<random>` database, migrates it
  from empty and drops it at the end.
- The worker test uses a random BullMQ key prefix.

So tests never touch development data. If a run is killed mid-way, leftover `workbox_it_*`
databases can be dropped safely.

## Reset and troubleshooting

| Problem                                         | Fix                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `port is already allocated`                     | Change `DB_PORT` / `REDIS_PORT` in `.env`                                                      |
| `DB_PASSWORD must be set`                       | You have no `.env`; run `cp .env.example .env`                                                 |
| `WORKBOX_MASTER_KEY is required`                | Run `pnpm vault:generate-key`                                                                  |
| `CREDENTIAL_UNREADABLE` / "cannot be decrypted" | The master key changed. Restore the old key, or replace the token on the Connections page      |
| `WORKER_UNAVAILABLE` on "Check now"             | The worker isn't running: start `pnpm dev` (or `pnpm dev:worker`)                              |
| Clone stays "Queued"                            | The worker isn't running (`pnpm dev`), or it's busy with another clone                         |
| Clone "Failed: authentication failed"           | The token was revoked or lacks access to the repository: replace it on Connections             |
| Worker: "not git-ignored"                       | `WORKBOX_WORKSPACES_DIR` points inside the Workbox repo; use the default or ignore it          |
| `CREDENTIAL_REJECTED`                           | The provider refused the token (expired, revoked, wrong permissions). Create a new one         |
| `password authentication failed`                | Bundled DB: credentials changed after the volume was created; see Option A                     |
| `workbox_test` missing                          | The volume predates the init script; run the reset below                                       |
| `/health/ready` returns 503                     | `docker compose ps`; the API log names the failing dependency                                  |
| Want a clean slate                              | `docker compose down -v` (**deletes all local data**), then `pnpm infra:up && pnpm db:migrate` |

## Failure recovery notes (M1 scope)

- **Redis restart:** Redis runs with AOF persistence (`appendonly yes`) and `noeviction`, so queued
  jobs survive restarts and are never silently evicted. API readiness reports `redis: down` until it
  reconnects. The worker reconnects automatically.
- **PostgreSQL restart:** idle pool errors are swallowed and the next query reconnects. Readiness
  reports `postgres: down` meanwhile.
- **Worker crash mid-job:** BullMQ marks the job stalled and redelivers it. Delivery is
  at-least-once, so processors must be idempotent. Fuller recovery and reconciliation are M4 scope.
