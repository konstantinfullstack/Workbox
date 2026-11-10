import type { Database } from '#database';

/** Who is acting and how to correlate the action with request logs. */
export interface ActionContext {
  actor: string;
  traceId?: string | undefined;
}

/** A Drizzle transaction handle (same query API as Database). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;
