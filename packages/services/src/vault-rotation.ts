import { auditLogs, credentials, type Database } from '#database';
import { reseal, type Keyring } from '#vault';
import { eq, isNotNull } from 'drizzle-orm';
import { credentialContext } from './connection-service.js';

export interface RotationSummary {
  rotated: number;
  total: number;
  keyVersion: number;
}

/**
 * Re-encrypts every stored credential under the keyring's current key, in one transaction (all or
 * nothing). Old keys must be present in the keyring. See docs/adr/003.
 */
export async function rotateCredentialKeys(
  db: Database,
  keyring: Keyring,
): Promise<RotationSummary> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(credentials)
      .where(isNotNull(credentials.ciphertext))
      .for('update');
    let rotated = 0;
    for (const row of rows) {
      const next = reseal(
        keyring,
        { ciphertext: row.ciphertext!, keyVersion: row.keyVersion },
        credentialContext(row.id, row.provider),
      );
      if (!next) continue;
      await tx
        .update(credentials)
        .set({ ciphertext: next.ciphertext, keyVersion: next.keyVersion })
        .where(eq(credentials.id, row.id));
      rotated++;
    }
    const summary = { rotated, total: rows.length, keyVersion: keyring.current.version };
    await tx.insert(auditLogs).values({
      actor: 'system:vault-rotate',
      action: 'vault.rotated',
      resourceType: 'vault',
      metadata: { ...summary },
    });
    return summary;
  });
}
