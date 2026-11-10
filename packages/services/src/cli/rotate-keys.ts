/**
 * `pnpm vault:rotate`: re-encrypts every stored credential under the current master key
 * (WORKBOX_MASTER_KEY / WORKBOX_MASTER_KEY_VERSION). Old keys must be listed in
 * WORKBOX_PREVIOUS_MASTER_KEYS while this runs. See docs/adr/003-credential-vault-and-master-key.md.
 */
import {
  ConfigError,
  createLogger,
  databaseConfigShape,
  parseConfig,
  postgresUrl,
  vaultConfigShape,
} from '#core';
import { createDatabase } from '#database';
import { Keyring } from '#vault';
import { z } from 'zod';
import { rotateCredentialKeys } from '../vault-rotation.js';

const logger = createLogger({ service: 'workbox-vault-rotate' });
const schema = z.object({ ...databaseConfigShape, ...vaultConfigShape });

try {
  const config = parseConfig(schema);
  const keyring = Keyring.fromConfig({
    currentKey: config.WORKBOX_MASTER_KEY,
    currentVersion: config.WORKBOX_MASTER_KEY_VERSION,
    ...(config.WORKBOX_PREVIOUS_MASTER_KEYS
      ? { previousKeys: config.WORKBOX_PREVIOUS_MASTER_KEYS }
      : {}),
  });
  const database = createDatabase({
    connectionString: postgresUrl(config),
    applicationName: 'workbox-vault-rotate',
  });
  try {
    const summary = await rotateCredentialKeys(database.db, keyring);
    logger.info(
      summary,
      summary.rotated > 0
        ? 'credentials re-encrypted'
        : 'all credentials already use the current key',
    );
  } finally {
    await database.close();
  }
} catch (error) {
  logger.fatal(
    error instanceof ConfigError ? { issues: error.issues } : { err: error },
    'key rotation failed',
  );
  process.exitCode = 1;
}
