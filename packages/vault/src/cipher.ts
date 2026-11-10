import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Keyring } from './keyring.js';
import { Secret } from './secret.js';

/**
 * Sealed format (version 1): [0x01][12-byte IV][16-byte GCM tag][ciphertext].
 * The format byte lets a future algorithm change coexist with stored data.
 */
const FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export interface SealedSecret {
  ciphertext: Buffer;
  keyVersion: number;
}

export class VaultDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultDecryptError';
  }
}

/**
 * Encrypts with AES-256-GCM under the keyring's current key. `context` is bound as additional
 * authenticated data: decrypting with a different context (e.g. after copying the blob onto
 * another row) fails.
 */
export function seal(keyring: Keyring, plaintext: string, context: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([Buffer.from([FORMAT_V1]), iv, cipher.getAuthTag(), encrypted]),
    keyVersion: keyring.current.version,
  };
}

/** Decrypts and authenticates. Any tampering, wrong key or wrong context throws VaultDecryptError. */
export function open(keyring: Keyring, sealed: SealedSecret, context: string): Secret {
  const { ciphertext } = sealed;
  if (ciphertext.length < 1 + IV_BYTES + TAG_BYTES || ciphertext[0] !== FORMAT_V1) {
    throw new VaultDecryptError('unrecognised ciphertext format');
  }
  const key = keyring.get(sealed.keyVersion);
  const iv = ciphertext.subarray(1, 1 + IV_BYTES);
  const tag = ciphertext.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = ciphertext.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return new Secret(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } catch {
    // Deliberately vague: never hint which part failed.
    throw new VaultDecryptError('credential could not be decrypted (wrong key or tampered data)');
  }
}

/** Re-encrypts under the current key, if it was sealed with an older one. */
export function reseal(
  keyring: Keyring,
  sealed: SealedSecret,
  context: string,
): SealedSecret | null {
  if (sealed.keyVersion === keyring.current.version) return null;
  return seal(keyring, open(keyring, sealed, context).reveal(), context);
}
