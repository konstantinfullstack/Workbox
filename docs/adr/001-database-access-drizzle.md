# ADR-001: Database access and migrations: Drizzle ORM on PostgreSQL

- **Status:** Accepted
- **Date:** 2026-11-04
- **Milestone:** M1

## Context

Spec §4 leaves the choice between Drizzle and Knex to this ADR. Requirements: typed schema,
reviewable migration files, foreign keys, uniqueness constraints and explicit indexes (§5),
migrations that apply from an empty database (M1 acceptance), and recovery-friendly operations (§11).

MySQL was briefly considered as the database and rejected, keeping the spec's PostgreSQL:

- PostgreSQL has transactional DDL, so a failed migration rolls back completely.
- Partial unique indexes can enforce "one active run per task/branch" invariants (§6).
- JSONB is indexable.
- `SKIP LOCKED` and `LISTEN/NOTIFY` suit the outbox and live updates.

## Decision

- **ORM / query builder:** Drizzle ORM (`drizzle-orm/node-postgres`) with the `pg` driver.
  The schema lives in `packages/database/src/schema/*.ts`.
- **Migrations:** `drizzle-kit generate` produces plain SQL in `packages/database/migrations/`.
  The SQL is committed and reviewed like code. Migrations are forward-only and immutable once
  merged.
- **Applying:** `runMigrations()` / `pnpm db:migrate` uses Drizzle's migrator inside a session
  advisory lock (`pg_advisory_lock(727001)`), so concurrent invocations serialise. Applications
  do **not** auto-migrate on startup; migrating is an explicit operational step.
- **Drift guard:** CI runs `db:generate` and fails if it produces changes, so a schema edit
  without a committed migration is caught.
- **Ownership:** only `packages/database` (`#database`) defines tables. Domain services (M2+) receive a
  `Database` handle and own their persistence boundaries (spec §4 nuance). Apps never import
  `pg` directly for domain queries.
- **Conventions:**
  - `uuid` primary keys via `gen_random_uuid()`.
  - `timestamptz` timestamps (`created_at`, `updated_at`).
  - `snake_case` identifiers (Drizzle `casing: 'snake_case'`).
  - Explicitly named indexes (`<table>_<cols>_idx`).
  - Foreign keys always declared.
  - No secrets in any `jsonb` column.
- **Baseline:** migration `0000_init_audit_logs` creates `audit_logs`, the append-only audit trail
  that M2 state transitions write to.

## Alternatives considered

- **Knex:** a mature migration runner, but its query results are weakly typed and need a
  separate typing layer. Its JS migration files are also harder to review than generated SQL.

## Consequences

- Schema types flow to callers (`AuditLog`, `NewAuditLog`) without hand-written interfaces.
- Complex migrations (data backfills, concurrent index builds) can be hand-written as additional
  SQL files with `drizzle-kit generate --custom`.
- `drizzle-kit` is a dev-only dependency. Production only needs `drizzle-orm` and `pg`.
