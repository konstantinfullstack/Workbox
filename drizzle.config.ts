import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs the TypeScript schema against previous migration snapshots;
// it does not connect to a database. Migrations are applied by `pnpm db:migrate` (packages/database/src/cli/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/database/src/schema/*.ts',
  out: './packages/database/migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
