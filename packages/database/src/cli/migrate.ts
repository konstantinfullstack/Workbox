import {
  ConfigError,
  createLogger,
  migrationConfigSchema,
  parseConfig,
  postgresUrl,
  redactUrl,
} from '#core';
import { runMigrations } from '../migrate.js';

const logger = createLogger({ service: 'workbox-migrate' });

try {
  const config = parseConfig(migrationConfigSchema);
  logger.level = config.LOG_LEVEL;
  const connectionString = postgresUrl(config);
  logger.info({ database: redactUrl(connectionString) }, 'applying migrations');
  const result = await runMigrations({ connectionString });
  logger.info(
    result,
    result.appliedCount > 0 ? 'migrations applied' : 'database already up to date',
  );
} catch (error) {
  if (error instanceof ConfigError) {
    logger.fatal({ issues: error.issues }, 'invalid configuration');
  } else {
    logger.fatal({ err: error }, 'migration failed');
  }
  process.exitCode = 1;
}
