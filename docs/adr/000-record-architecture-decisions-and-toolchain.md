# ADR-000: Record architecture decisions; repository toolchain

- **Status:** Accepted
- **Date:** 2026-11-04
- **Milestone:** M1

## Context

The specification (§15) asks for ADRs for significant decisions and proposes a TypeScript
repository with `apps/` and `packages/` (§4), built as a modular monolith (§2 "Start simple").
The tooling choices behind that structure need to be written down so later milestones, and other
AI coding agents, follow them consistently.

## Decision

1. **ADRs** live in `docs/adr/NNN-kebab-title.md` with Status, Date, Context, Decision and
   Consequences. Numbers 001–008 are reserved for the topics listed in spec §15. ADRs are never
   rewritten after acceptance; a later ADR supersedes an earlier one.
2. **Single package, not a workspace.** One root `package.json`, one `node_modules`, one
   `pnpm-lock.yaml`, one `tsconfig.json` (typecheck) and one `tsconfig.build.json` (emit).
   `apps/*` and `packages/*` are source folders with module boundaries, not separately installed
   packages. This avoids version drift between modules and per-package boilerplate. Splitting into
   workspace packages later is mechanical if independent deployment ever requires it.
3. **Module boundaries** use Node subpath imports declared in the root `package.json`:
   `#core`, `#shared` and `#database`. Code outside a module imports only its public entry
   (`src/index.ts`), never its internal files. Each mapping has two targets:
   - `@workbox/source` points at the TypeScript source. `tsx`, `tsc` and Vitest enable this
     condition, so development and tests need no build step.
   - `default` points at `dist/…/index.js`, which plain `node` uses for compiled output.
     `tsc -p tsconfig.build.json` compiles everything in one program into `dist/`, mirroring the
     source tree (`dist/apps/api/src/server.js`). Code needing repository-relative paths (version,
     migrations) uses `PROJECT_ROOT` from `#core` rather than `import.meta.url` depth, which
     differs between sources and `dist/`.
4. **Package manager:** pnpm, pinned through `packageManager` and Corepack.
   `pnpm-workspace.yaml` exists only to hold pnpm settings. Its install-script allowlist
   (`allowBuilds`) permits only `esbuild`. `msgpackr-extract` (an optional native accelerator
   pulled in by BullMQ) is denied; msgpackr falls back to pure JS.
5. **Runtime:** Node.js 24, ESM only (`"type": "module"`).
6. **TypeScript 6.0:** strict, `NodeNext`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
   TypeScript 7 (the native compiler) is not used yet, because `typescript-eslint` supports
   `typescript <6.1`.
7. **Quality tooling:** ESLint flat config with `typescript-eslint` type-aware rules, Prettier,
   and Vitest with separate `unit` and `integration` projects.
8. **Validation:** Zod in `packages/shared` (`#shared`) is the single schema source. Fastify uses
   `fastify-type-provider-zod` for request/response validation and OpenAPI generation, so the
   future dashboard and CLI share the same contracts.
9. **Logging:** pino (Fastify's native logger) with a shared redaction list in `#core`.

## Consequences

- Adding a dependency is a single `pnpm add` at the root.
- Adding a module means creating `packages/<name>/src/index.ts` and adding a `#<name>` entry to
  `imports`.
- Boundaries are a convention, not enforced by package isolation. Add a lint rule
  (e.g. `no-restricted-imports` for deep paths) if violations appear.
- The React dashboard (M2) has its own Vite build. Whether it shares the root `package.json` is
  revisited then.
- Moving to TypeScript 7 is a future ADR, once lint tooling supports it.
