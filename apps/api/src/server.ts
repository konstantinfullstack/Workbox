import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiConfigSchema,
  ConfigError,
  createLogger,
  parseConfig,
  postgresUrl,
  redactUrl,
  redisUrl,
  PROJECT_ROOT,
  WORKBOX_VERSION,
} from '#core';
import { createDatabase } from '#database';
import { createServices } from '#services';
import { Keyring, VaultKeyError } from '#vault';
import { Redis } from 'ioredis';
import { buildApp, SERVICE_NAME } from './app.js';
import { createWorkerGateway } from './worker-gateway.js';

const bootLogger = createLogger({ service: SERVICE_NAME });
/** Output of `pnpm build` (vite). In dev, the dashboard is served by Vite on :5173 instead. */
const WEB_ROOT = join(PROJECT_ROOT, 'dist', 'web');

async function main(): Promise<void> {
  const config = parseConfig(apiConfigSchema);
  const databaseUrl = postgresUrl(config);
  const cacheUrl = redisUrl(config);
  const keyring = Keyring.fromConfig({
    currentKey: config.WORKBOX_MASTER_KEY,
    currentVersion: config.WORKBOX_MASTER_KEY_VERSION,
    ...(config.WORKBOX_PREVIOUS_MASTER_KEYS
      ? { previousKeys: config.WORKBOX_PREVIOUS_MASTER_KEYS }
      : {}),
  });
  const workerGateway = createWorkerGateway({ redisUrl: cacheUrl });

  const database = createDatabase({
    connectionString: databaseUrl,
    applicationName: SERVICE_NAME,
  });
  // Fail-fast client for probes: no offline queue, no unbounded retries per command.
  const redis = new Redis(cacheUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectionName: SERVICE_NAME,
  });
  redis.on('error', () => undefined); // surfaced through readiness checks instead

  const app = await buildApp({
    version: WORKBOX_VERSION,
    logLevel: config.LOG_LEVEL,
    corsOrigins: config.CORS_ORIGINS,
    services: createServices({ db: database.db, keyring, workerGateway }),
    ...(existsSync(join(WEB_ROOT, 'index.html')) ? { webRoot: WEB_ROOT } : {}),
    readinessChecks: {
      postgres: () => database.ping(),
      redis: async () => {
        if (redis.status === 'wait' || redis.status === 'end') {
          await redis.connect();
        }
        await redis.ping();
      },
    },
  });

  app.addHook('onClose', async () => {
    await workerGateway.close();
    redis.disconnect();
    await database.close();
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.log.info({ database: redactUrl(databaseUrl), redis: redactUrl(cacheUrl) }, 'starting');
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    bootLogger.fatal({ issues: error.issues }, 'invalid configuration');
  } else if (error instanceof VaultKeyError) {
    bootLogger.fatal({ issues: [error.message] }, 'invalid vault master key');
  } else {
    bootLogger.fatal({ err: error }, 'failed to start');
  }
  process.exit(1);
});
