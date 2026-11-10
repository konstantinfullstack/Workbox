import type { CodeHostProvider } from '#shared';
import { CODE_HOSTS } from '#shared';
import { CodeHostError } from './code-host.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalises and validates an instance URL entered by the user. HTTPS is required (tokens travel
 * in headers); plain HTTP is accepted only for loopback hosts, which tests use.
 */
export function normalizeInstanceUrl(provider: CodeHostProvider, input?: string | null): string {
  const raw = input?.trim() || CODE_HOSTS[provider].defaultBaseUrl;
  if (!URL.canParse(raw)) {
    throw new CodeHostError('invalid_url', 'instance URL is not a valid URL');
  }
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new CodeHostError('invalid_url', 'instance URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new CodeHostError('invalid_url', 'instance URL must not contain a query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new CodeHostError('invalid_url', 'instance URL must use https://');
  }
  // Users often paste the API URL; store the instance URL instead.
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/(v3|v4)$/, '');
  if (provider === 'github' && url.hostname === 'api.github.com') return 'https://github.com';
  return `${url.protocol}//${url.host}${path}`;
}

export function instanceHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}
