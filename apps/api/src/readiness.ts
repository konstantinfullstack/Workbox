import type { DependencyCheck } from '#shared';

/** A dependency probe. Resolves when healthy, rejects (or hangs) when not. */
export type ReadinessCheck = () => Promise<void>;

export interface CheckOutcome extends DependencyCheck {
  /** Internal-only failure reason; logged, never returned to clients. */
  error?: unknown;
}

export async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckOutcome> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`check timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: elapsed(startedAt) };
  } catch (error) {
    return { status: 'down', latencyMs: elapsed(startedAt), error };
  } finally {
    clearTimeout(timer);
  }
}

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
