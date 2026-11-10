import { sql, type SQL } from 'drizzle-orm';

/**
 * Renders `column IN ('a','b',...)` for a CHECK constraint from a TypeScript const list, so the
 * allowed values have a single source of truth (#shared). Values are compile-time constants, never
 * user input, so inlining them is safe.
 */
export function inList(column: SQL, values: readonly string[]): SQL {
  for (const value of values) {
    if (!/^[a-z_]+$/.test(value)) throw new Error(`unsafe enum literal: ${value}`);
  }
  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}
