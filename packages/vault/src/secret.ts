import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * Wraps a plaintext secret so it cannot leak by accident: string conversion, JSON serialisation,
 * template literals and `util.inspect` (used by console.log and pino) all print `[REDACTED]`.
 * Call `reveal()` only at the exact point the value is sent to its provider.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

/**
 * Display-safe hint: the token's well-known prefix (if any) plus its last 4 characters, e.g.
 * `github_pat_…a1B2`, `glpat-…x9Yz`. Never enough to reconstruct or use the secret.
 */
export function fingerprint(secret: string): string {
  const prefix = /^(github_pat_|ghp_|gho_|ghu_|ghs_|glpat-|gldt-|sk-ant-)/.exec(secret)?.[1] ?? '';
  const tail = secret.length >= 12 ? secret.slice(-4) : '';
  return `${prefix}…${tail}`;
}
