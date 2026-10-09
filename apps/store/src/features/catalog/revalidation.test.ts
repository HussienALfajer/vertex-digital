import { describe, expect, it } from 'vitest';
import { authorizedRevalidation } from './revalidation';

const SECRET = 's'.repeat(44);

const headers = (values: Record<string, string>) => new Headers(values);

describe('authorizedRevalidation (rule SF4)', () => {
  it('accepts the secret from the loopback', () => {
    for (const host of ['127.0.0.1:3061', 'localhost:3001', '[::1]:3061']) {
      expect(
        authorizedRevalidation(headers({ host, authorization: `Bearer ${SECRET}` }), SECRET),
      ).toBe(true);
    }
    expect(
      authorizedRevalidation(
        headers({
          host: '127.0.0.1:3061',
          'x-forwarded-for': '::ffff:127.0.0.1',
          authorization: `Bearer ${SECRET}`,
        }),
        SECRET,
      ),
    ).toBe(true);
  });

  it('refuses a wrong or missing secret', () => {
    const host = '127.0.0.1:3061';
    expect(authorizedRevalidation(headers({ host }), SECRET)).toBe(false);
    expect(authorizedRevalidation(headers({ host, authorization: SECRET }), SECRET)).toBe(false);
    expect(
      authorizedRevalidation(headers({ host, authorization: `Bearer ${SECRET}x` }), SECRET),
    ).toBe(false);
  });

  it('refuses a proxied request or another host, even with the secret', () => {
    const authorization = `Bearer ${SECRET}`;
    const proxied: Record<string, string>[] = [
      { host: '127.0.0.1:3061', 'x-forwarded-for': '203.0.113.9' },
      { host: '127.0.0.1:3061', 'x-real-ip': '203.0.113.9' },
      { host: '127.0.0.1:3061', forwarded: 'for=203.0.113.9' },
      { host: 'digital.vertexmedia.pro' },
    ];
    for (const extra of proxied) {
      expect(authorizedRevalidation(headers({ ...extra, authorization }), SECRET)).toBe(false);
    }
  });
});
