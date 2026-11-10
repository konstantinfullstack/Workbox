# Workbox

AI-agnostic autonomous software development orchestration platform. See
[`WORKBOX_PROJECT_SPEC.md`](WORKBOX_PROJECT_SPEC.md) for the vision, architecture and roadmap, and
[`docs/PROGRESS.md`](docs/PROGRESS.md) for current implementation status.

> **Status:** Milestone 3 (Credential vault and connections). You can manage projects and tasks,
> connect GitHub and GitLab accounts (tokens encrypted at rest), link each project to its repository
> with verified access, and check that Claude Code is ready on this machine. Linked repositories
> are cloned automatically into the git-ignored `workspaces/` folder (M4 phase A). Agents don't run yet.
>
> Already in place from M2: a validated task state machine with full status history.

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 12 (`corepack enable` picks up the pinned version from `package.json`)
- Docker with Compose v2

## Quick start

```bash
cp .env.example .env          # local placeholders only; see docs/operations/local-setup.md
pnpm install
pnpm vault:generate-key       # writes WORKBOX_MASTER_KEY into .env (never printed). Back it up.
pnpm infra:up                 # docker compose up -d --wait (Redis, plus PostgreSQL if enabled)
pnpm db:migrate               # apply migrations
pnpm dev                      # API :3000, worker, and dashboard on http://127.0.0.1:5173
```

Check it works:

```bash
open http://127.0.0.1:5173               # dashboard (dev); `pnpm build && pnpm start:api` serves it on :3000
curl http://127.0.0.1:3000/health/ready  # PostgreSQL + Redis → 200, or 503 if either is down
open http://127.0.0.1:3000/docs          # OpenAPI / Swagger UI for /api/v1
```

## Common commands

| Command                           | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `pnpm infra:up` / `down`          | Start / stop PostgreSQL and Redis (data kept in volumes)     |
| `pnpm dev`                        | API, worker and dashboard (Vite) from sources, with reload   |
| `pnpm start:api` / `start:worker` | Run the compiled output from `dist/` (after `pnpm build`)    |
| `pnpm db:generate`                | Generate a SQL migration from Drizzle schema changes         |
| `pnpm db:migrate`                 | Apply pending migrations (idempotent, advisory-locked)       |
| `pnpm vault:generate-key`         | Create the vault master key in `.env` (refuses to overwrite) |
| `pnpm vault:rotate`               | Re-encrypt all stored tokens under the current master key    |
| `pnpm lint`                       | ESLint (type-aware)                                          |
| `pnpm format:check`               | Prettier check (`pnpm format` to fix)                        |
| `pnpm typecheck`                  | `tsc` over the whole repository                              |
| `pnpm test`                       | Unit + dashboard component tests (no infrastructure)         |
| `pnpm test:integration`           | Integration tests against Compose PostgreSQL/Redis           |
| `pnpm build`                      | Compile server code and the dashboard bundle to `dist/`      |
| `pnpm check`                      | lint + format + typecheck + unit tests + build               |

## Repository layout

A single package: one root `package.json`, `node_modules`, lockfile and tsconfig. `apps/` and
`packages/` are source folders. Modules import each other through the subpath aliases
`#core`, `#shared`, `#database`, `#services`, `#vault` and `#integrations`, declared in the root
`package.json`
([ADR-000](docs/adr/000-record-architecture-decisions-and-toolchain.md)).

```text
apps/
  api/         Fastify REST API (/api/v1, health, OpenAPI at /docs); serves the built dashboard
  web/         React + Vite admin dashboard (projects, task board, task detail)
  worker/      BullMQ consumer (system queue with a ping job)
packages/
  core/        Config, logger with redaction, domain rules (task state machine)
  database/    Drizzle schema, SQL migrations, migrator
  integrations/ Code-host adapters (GitHub, GitLab) and the Claude Code probe
  services/    Domain services: projects, tasks, accounts, repositories, agent runtimes
  vault/       AES-256-GCM credential encryption, keyring, Secret type
  shared/      Zod schemas / DTOs / validation shared by server and dashboard
docs/
  adr/         Architecture decision records
  plans/       Approved milestone plans
  operations/  Local setup and troubleshooting
infra/docker/  Container init scripts
```

More detail: [`docs/operations/local-setup.md`](docs/operations/local-setup.md).

## Security

- Never commit `.env` or real credentials. `.env.example` contains placeholders only.
- Compose binds PostgreSQL and Redis to `127.0.0.1`. The local stack is for development only.
- Logs redact authorization headers, cookies, secret-like fields and connection-string passwords.
- **Tokens** (GitHub/GitLab) are verified, then encrypted with AES-256-GCM. They are never returned
  by the API, never logged and never given to agents. The master key lives only in `.env`
  ([ADR-003](docs/adr/003-credential-vault-and-master-key.md)). Back it up: without it, stored
  tokens must be re-entered.
- `.env` holds the master key: keep it owner-readable only (`chmod 600 .env`; the key generator
  does this).
