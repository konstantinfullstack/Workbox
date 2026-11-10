import { randomBytes } from 'node:crypto';

export const KEY_BYTES = 32;

export interface MasterKey {
  version: number;
  key: Buffer;
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

/**
 * The set of master keys the vault can use: one current key (for new encryptions) plus previous
 * keys (to decrypt secrets not yet re-encrypted by `pnpm vault:rotate`). Keys live outside the
 * database (spec §8): in the environment for local deployments.
 */
export class Keyring {
  readonly current: MasterKey;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(current: MasterKey, previous: MasterKey[] = []) {
    const keys = new Map<number, Buffer>();
    for (const entry of [current, ...previous]) {
      assertKey(entry);
      if (keys.has(entry.version)) {
        throw new VaultKeyError(`duplicate master key version ${entry.version}`);
      }
      keys.set(entry.version, entry.key);
    }
    this.current = current;
    this.#keys = keys;
  }

  get(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) {
      throw new VaultKeyError(
        `no master key for version ${version}; add it to WORKBOX_PREVIOUS_MASTER_KEYS or re-enter the credential`,
      );
    }
    return key;
  }

  get versions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b);
  }

  /**
   * Builds a keyring from environment-style values:
   * - `currentKey`: base64 of 32 random bytes (WORKBOX_MASTER_KEY)
   * - `currentVersion`: positive integer (WORKBOX_MASTER_KEY_VERSION, default 1)
   * - `previousKeys`: comma-separated `version:base64` pairs (WORKBOX_PREVIOUS_MASTER_KEYS)
   */
  static fromConfig(options: {
    currentKey: string;
    currentVersion?: number;
    previousKeys?: string;
  }): Keyring {
    const current = {
      version: options.currentVersion ?? 1,
      key: decodeKey(options.currentKey, 'WORKBOX_MASTER_KEY'),
    };
    const previous = (options.previousKeys ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(':');
        const version = Number(entry.slice(0, separator));
        if (separator < 1 || !Number.isInteger(version) || version < 1) {
          throw new VaultKeyError(
            'WORKBOX_PREVIOUS_MASTER_KEYS entries must look like "<version>:<base64 key>"',
          );
        }
        return { version, key: decodeKey(entry.slice(separator + 1), `previous key v${version}`) };
      });
    return new Keyring(current, previous);
  }
}

/** A fresh random master key, base64-encoded. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

function decodeKey(value: string, label: string): Buffer {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new VaultKeyError(`${label} must be base64 (generate one with: pnpm vault:generate-key)`);
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new VaultKeyError(`${label} must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

function assertKey(entry: MasterKey): void {
  if (!Number.isInteger(entry.version) || entry.version < 1) {
    throw new VaultKeyError('master key versions must be positive integers');
  }
  if (entry.key.length !== KEY_BYTES) {
    throw new VaultKeyError(`master keys must be ${KEY_BYTES} bytes`);
  }
}
