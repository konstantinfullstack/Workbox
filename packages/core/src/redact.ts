export const REDACTED = '[REDACTED]';

/** Masks the password (and username, if present with a password) in a connection URL for safe logging. */
export function redactUrl(value: string): string {
  if (!URL.canParse(value)) {
    return REDACTED;
  }
  const url = new URL(value);
  if (url.password) {
    url.password = 'REDACTED'; // plain token: brackets would be percent-encoded
  }
  // Query parameters may carry credentials (e.g. ?password=, ?sslkey=); drop them entirely.
  url.search = '';
  return url.toString();
}

/**
 * Log paths that must never be emitted. Applied to every logger created through createLogger().
 * Pino path syntax: https://getpino.io/#/docs/redaction
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.privateKey',
  '*.DB_PASSWORD',
  '*.WORKBOX_MASTER_KEY',
  '*.WORKBOX_PREVIOUS_MASTER_KEYS',
  'req.body.secret',
  '*.REDIS_PASSWORD',
] as const;
