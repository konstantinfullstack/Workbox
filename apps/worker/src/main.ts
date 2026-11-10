import { hostname } from 'node:os';
import {
  ConfigError,
  createLogger,
  parseConfig,
  postgresUrl,
  PROJECT_ROOT,
  redactUrl,
  redisUrl,
  workerConfigSchema,
} from '#core';
import { createDatabase } from '#database';
import { assertWorkspacesRoot } from '#git';
import { createCodeHostRegistry } from '#integrations';
import { createAgentRegistry } from '#agents';
import { ConnectionService, Publisher, RunExecutor, WorkspaceSyncer } from '#services';
import { QUEUE_NAMES } from '#shared';
import { Keyring, VaultKeyError } from '#vault';
import { Queue } from 'bullmq';
import { createSystemWorker } from './worker.js';
import { createRunWorker, enqueueRuns } from './run-worker.js';
import { createWorkspaceWorker, enqueuePendingSyncs } from './workspace-worker.js';

const SERVICE_NAME = 'workbox-worker';
const logger = createLogger({ service: SERVICE_NAME });

async function main(): Promise<void> {
  const config = parseConfig(workerConfigSchema);
  logger.level = config.LOG_LEVEL;
  const workerId = config.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const cacheUrl = redisUrl(config);
  const root = config.WORKBOX_WORKSPACES_DIR;
  // Cloned code must never be committed to the Workbox repo by accident.
  await assertWorkspacesRoot(root, PROJECT_ROOT);

  const keyring = Keyring.fromConfig({
    currentKey: config.WORKBOX_MASTER_KEY,
    currentVersion: config.WORKBOX_MASTER_KEY_VERSION,
    ...(config.WORKBOX_PREVIOUS_MASTER_KEYS
      ? { previousKeys: config.WORKBOX_PREVIOUS_MASTER_KEYS }
      : {}),
  });
  const database = createDatabase({
    connectionString: postgresUrl(config),
    applicationName: SERVICE_NAME,
    max: 4,
  });
  const codeHosts = createCodeHostRegistry();
  const connections = new ConnectionService({ db: database.db, keyring, codeHosts });
  const publisher = new Publisher(database.db, codeHosts, connections);
  const syncer = new WorkspaceSyncer({ db: database.db, connections, root, workerId });
  const executor = new RunExecutor({
    db: database.db,
    agents: createAgentRegistry({
      claudeCode: config.CLAUDE_CODE_COMMAND ? { command: config.CLAUDE_CODE_COMMAND } : {},
    }),
    syncer,
    workerId,
    timeoutMs: config.WORKBOX_RUN_TIMEOUT_MINUTES * 60_000,
    connections,
    publisher,
    ...(config.WORKBOX_GIT_AUTHOR_NAME ? { authorName: config.WORKBOX_GIT_AUTHOR_NAME } : {}),
  });

  logger.info(
    {
      workerId,
      redis: redactUrl(cacheUrl),
      queues: [QUEUE_NAMES.system, QUEUE_NAMES.workspaces, QUEUE_NAMES.runs],
      workspaces: root,
    },
    'starting',
  );

  const child = logger.child({ workerId });
  const systemWorker = createSystemWorker({
    redisUrl: cacheUrl,
    workerId,
    logger: child,
    concurrency: config.WORKER_CONCURRENCY,
    claudeCommand: config.CLAUDE_CODE_COMMAND,
  });
  const workspaceWorker = createWorkspaceWorker({ redisUrl: cacheUrl, syncer, logger: child });
  const workspaceQueue = new Queue(QUEUE_NAMES.workspaces, {
    connection: { url: cacheUrl, maxRetriesPerRequest: null },
  });
  // Recover before consuming: runs orphaned by a crash are failed, queued ones re-enqueued.
  const recovery = await executor.recover();
  const runWorker = createRunWorker({ redisUrl: cacheUrl, executor, publisher, logger: child });
  const runQueue = new Queue(QUEUE_NAMES.runs, {
    connection: { url: cacheUrl, maxRetriesPerRequest: null },
  });
  await enqueueRuns(runQueue, recovery.queued);
  await Promise.all([
    systemWorker.waitUntilReady(),
    workspaceWorker.waitUntilReady(),
    runWorker.waitUntilReady(),
  ]);

  // Crash/upgrade recovery: anything linked but not cloned gets (re)synced.
  const queued = await enqueuePendingSyncs(workspaceQueue, syncer);
  logger.info(
    {
      queuedWorkspaceSyncs: queued,
      failedOrphanedRuns: recovery.failed,
      requeuedRuns: recovery.queued.length,
    },
    'worker ready',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down; waiting for active jobs');
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();
    Promise.all([
      systemWorker.close(),
      workspaceWorker.close(),
      runWorker.close(), // waits for an active run; the force-exit timer bounds this
      workspaceQueue.close(),
      runQueue.close(),
    ])
      .then(() => database.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'error during shutdown');
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.fatal({ issues: error.issues }, 'invalid configuration');
  } else if (error instanceof VaultKeyError) {
    logger.fatal({ issues: [error.message] }, 'invalid vault master key');
  } else {
    logger.fatal({ err: error }, 'failed to start');
  }
  process.exit(1);
});
