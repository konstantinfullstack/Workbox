/** Extracts a PostgreSQL error (code + constraint) from a driver error, possibly wrapped by Drizzle. */
export function pgErrorInfo(error: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
