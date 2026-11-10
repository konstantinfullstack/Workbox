import { CodeHostError } from './code-host.js';

export interface HttpOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

/**
 * GET a JSON resource from a code host. Maps transport and HTTP failures to CodeHostError with a
 * message that is safe to display: provider error text is truncated and scrubbed of the token.
 */
export async function getJson<T>(
  url: string,
  init: { headers: Record<string, string>; providerLabel: string; token: string },
  options: HttpOptions = {},
): Promise<JsonResponse<T>> {
  return requestJson<T>('GET', url, init, options);
}

/**
 * Sends a JSON request to a code host. Maps transport and HTTP failures to CodeHostError with a
 * message that is safe to display: provider error text is truncated and scrubbed of the token.
 */
export async function requestJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  init: { headers: Record<string, string>; providerLabel: string; token: string; body?: unknown },
  options: HttpOptions = {},
): Promise<JsonResponse<T>> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'workbox',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'error',
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CodeHostError(
      'unavailable',
      timedOut
        ? `${init.providerLabel} did not respond in time`
        : `could not reach ${init.providerLabel} at ${new URL(url).host}`,
    );
  }

  if (!response.ok) {
    const detail = scrub(await providerMessage(response), init.token);
    const suffix = detail ? `: ${detail}` : '';
    const status = response.status;
    if (status === 401) {
      throw new CodeHostError(
        'unauthorized',
        `${init.providerLabel} rejected the token (invalid, revoked or expired)${suffix}`,
        status,
      );
    }
    if (
      status === 429 ||
      (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      throw new CodeHostError(
        'rate_limited',
        `${init.providerLabel} rate limit reached; try again later`,
        status,
      );
    }
    if (status === 403) {
      throw new CodeHostError('forbidden', `${init.providerLabel} denied access${suffix}`, status);
    }
    if (status === 404) {
      throw new CodeHostError(
        'not_found',
        `${init.providerLabel} returned not found${suffix}`,
        status,
      );
    }
    if (status === 409 || status === 422) {
      throw new CodeHostError(
        'rejected',
        `${init.providerLabel} rejected the request${suffix}`,
        status,
      );
    }
    throw new CodeHostError('unavailable', `${init.providerLabel} returned HTTP ${status}`, status);
  }

  try {
    return { data: (await response.json()) as T, headers: response.headers };
  } catch {
    throw new CodeHostError(
      'invalid_response',
      `${init.providerLabel} returned an unexpected response`,
    );
  }
}

async function providerMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    const message = body.message ?? body.error_description ?? body.error;
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}
