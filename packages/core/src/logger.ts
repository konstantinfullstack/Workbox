import { pino, type Logger, type LoggerOptions } from 'pino';
import { LOG_REDACT_PATHS, REDACTED } from './redact.js';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions['level'];
  /** Optional destination stream, primarily for tests. */
  destination?: pino.DestinationStream;
}

/** Shared pino options so API (Fastify) and worker logs have identical shape and redaction. */
export function loggerOptions(
  service: string,
  level: LoggerOptions['level'] = 'info',
): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const opts = loggerOptions(options.service, options.level);
  return options.destination ? pino(opts, options.destination) : pino(opts);
}
