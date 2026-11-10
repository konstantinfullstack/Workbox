import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  generateMasterKey,
  Keyring,
  open,
  reseal,
  seal,
  Secret,
  VaultDecryptError,
  VaultKeyError,
} from '../src/index.js';

const TOKEN = 'github_pat_11ABCDEFG0123456789_supersecretvalue_a1B2';
const keyring = (version = 1, key = generateMasterKey(), previousKeys?: string) =>
  Keyring.fromConfig({
    currentKey: key,
    currentVersion: version,
    ...(previousKeys ? { previousKeys } : {}),
  });

describe('seal / open', () => {
  it('round-trips a secret and never stores plaintext', () => {
    const ring = keyring();
    const sealed = seal(ring, TOKEN, 'cred-1:github');
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN))).toBe(false);
    expect(open(ring, sealed, 'cred-1:github').reveal()).toBe(TOKEN);
  });

  it('uses a fresh IV every time', () => {
    const ring = keyring();
    const a = seal(ring, TOKEN, 'ctx');
    const b = seal(ring, TOKEN, 'ctx');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a different context (blob copied to another row)', () => {
    const ring = keyring();
    const sealed = seal(ring, TOKEN, 'cred-1:github');
    expect(() => open(ring, sealed, 'cred-2:github')).toThrow(VaultDecryptError);
  });

  it.each([
    ['format byte', 0],
    ['IV', 5],
    ['auth tag', 20],
    ['ciphertext body', 40],
  ])('rejects tampering with the %s', (_label, index) => {
    const ring = keyring();
    const sealed = seal(ring, TOKEN, 'ctx');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[index] = tampered[index]! ^ 0xff;
    expect(() => open(ring, { ...sealed, ciphertext: tampered }, 'ctx')).toThrow(VaultDecryptError);
  });

  it('rejects the wrong key without revealing why', () => {
    const sealed = seal(keyring(), TOKEN, 'ctx');
    expect(() => open(keyring(), sealed, 'ctx')).toThrow(/wrong key or tampered data/);
  });

  it('reports an unknown key version clearly', () => {
    const sealed = seal(keyring(3), TOKEN, 'ctx');
    expect(() => open(keyring(1), sealed, 'ctx')).toThrow(VaultKeyError);
  });
});

describe('key rotation', () => {
  it('decrypts old secrets with a previous key and reseals them under the current key', () => {
    const oldKey = generateMasterKey();
    const sealedOld = seal(keyring(1, oldKey), TOKEN, 'ctx');

    const rotated = keyring(2, generateMasterKey(), `1:${oldKey}`);
    expect(rotated.versions).toEqual([1, 2]);
    expect(open(rotated, sealedOld, 'ctx').reveal()).toBe(TOKEN);

    const resealed = reseal(rotated, sealedOld, 'ctx');
    expect(resealed?.keyVersion).toBe(2);
    expect(
      open(
        keyring(2, Buffer.from(rotated.current.key).toString('base64')),
        resealed!,
        'ctx',
      ).reveal(),
    ).toBe(TOKEN);
    expect(reseal(rotated, resealed!, 'ctx')).toBeNull();
  });
});

describe('Keyring.fromConfig', () => {
  it.each([
    ['not base64!', /base64/],
    [Buffer.alloc(16).toString('base64'), /32 bytes/],
    ['', /base64/],
  ])('rejects a bad current key %j', (key, message) => {
    expect(() => Keyring.fromConfig({ currentKey: key })).toThrow(message);
  });

  it('rejects malformed or duplicate previous keys', () => {
    const key = generateMasterKey();
    expect(() => Keyring.fromConfig({ currentKey: key, previousKeys: 'nope' })).toThrow(
      /<version>:<base64 key>/,
    );
    expect(() =>
      Keyring.fromConfig({ currentKey: key, previousKeys: `1:${generateMasterKey()}` }),
    ).toThrow(/duplicate/);
  });

  it('never includes key material in error messages', () => {
    const almost = Buffer.alloc(31, 7).toString('base64');
    try {
      Keyring.fromConfig({ currentKey: almost });
    } catch (error) {
      expect(String(error)).not.toContain(almost);
    }
  });
});

describe('Secret', () => {
  it('never reveals itself through stringification, JSON or inspection', () => {
    const secret = new Secret(TOKEN);
    expect(String(secret)).toBe('[REDACTED]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- deliberately testing template literals
    expect(`${secret}`).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect({ nested: { secret } })).not.toContain(TOKEN);
    expect(secret.reveal()).toBe(TOKEN);
  });
});

describe('fingerprint', () => {
  it.each([
    ['github_pat_11ABCDEFG0123456789_xyz_a1B2', 'github_pat_…a1B2'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_…6789'],
    ['glpat-abcdefghijklmnopqrst', 'glpat-…qrst'],
    ['short', '…'],
  ])('%s → %s', (secret, expected) => {
    expect(fingerprint(secret)).toBe(expected);
  });
});
