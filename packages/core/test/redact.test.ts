import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { redactUrl } from '../src/redact.js';

describe('redactUrl', () => {
  it('masks the password and keeps the rest of the URL', () => {
    expect(redactUrl('postgres://workbox:hunter2@db.internal:5432/workbox')).toBe(
      'postgres://workbox:REDACTED@db.internal:5432/workbox',
    );
  });

  it('drops query parameters that may carry credentials', () => {
    expect(redactUrl('redis://cache:6379/0?password=hunter2')).toBe('redis://cache:6379/0');
  });

  it('leaves URLs without credentials intact', () => {
    expect(redactUrl('redis://127.0.0.1:56379')).toBe('redis://127.0.0.1:56379');
  });

  it('fully redacts unparseable input', () => {
    expect(redactUrl('hunter2 is not a url')).toBe('[REDACTED]');
  });
});

describe('createLogger', () => {
  it('redacts secret-like fields and auth headers', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger({ service: 'test', destination });

    logger.info(
      {
        credential: { token: 'tok-123', apiKey: 'key-456', password: 'pw-789' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=def' } },
      },
      'event',
    );

    const output = lines.join('');
    for (const secret of ['tok-123', 'key-456', 'pw-789', 'Bearer abc', 'sid=def']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
    expect(JSON.parse(output)).toMatchObject({ service: 'test', msg: 'event' });
  });
});
