import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';

const DATABASE_URL = 'postgres://app:pw@127.0.0.1:5432/vertex_digital';
const secret = (label: string) => `${label}-${'x'.repeat(40)}`;

const production = {
  NODE_ENV: 'production',
  DATABASE_URL,
  STORE_URL: 'https://digital.vertexmedia.pro',
  ADMIN_URL: 'https://digital-admin.vertexmedia.pro',
  CUSTOMER_AUTH_SECRET: secret('customer'),
  STAFF_AUTH_SECRET: secret('staff'),
  ALTCHA_HMAC_KEY: secret('altcha'),
};

describe('API environment', () => {
  it('derives local secrets and treats the .env.example placeholders as unset', () => {
    const env = parseEnv({
      DATABASE_URL,
      CUSTOMER_AUTH_SECRET: 'replace-with-a-long-random-value',
      SENTRY_DSN: '',
    });
    expect(env.CUSTOMER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.STAFF_AUTH_SECRET).not.toBe(env.CUSTOMER_AUTH_SECRET);
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(parseEnv({ DATABASE_URL }).CUSTOMER_AUTH_SECRET).toBe(env.CUSTOMER_AUTH_SECRET);
  });

  it('accepts a complete production environment', () => {
    expect(parseEnv(production)).toMatchObject({
      STORE_URL: 'https://digital.vertexmedia.pro',
      STAFF_AUTH_SECRET: production.STAFF_AUTH_SECRET,
    });
  });

  it.each(['CUSTOMER_AUTH_SECRET', 'STAFF_AUTH_SECRET', 'ALTCHA_HMAC_KEY'])(
    'refuses production without %s, or with its placeholder',
    (key) => {
      expect(() => parseEnv({ ...production, [key]: undefined })).toThrow(key);
      expect(() => parseEnv({ ...production, [key]: 'replace-with-a-long-random-value' })).toThrow(
        key,
      );
    },
  );

  it('refuses http origins and a shared auth secret in production', () => {
    expect(() =>
      parseEnv({ ...production, ADMIN_URL: 'http://digital-admin.vertexmedia.pro' }),
    ).toThrow('ADMIN_URL');
    expect(() =>
      parseEnv({ ...production, STAFF_AUTH_SECRET: production.CUSTOMER_AUTH_SECRET }),
    ).toThrow('STAFF_AUTH_SECRET');
  });

  it('refuses a short secret', () => {
    expect(() => parseEnv({ DATABASE_URL, STAFF_AUTH_SECRET: 'short' })).toThrow(
      'STAFF_AUTH_SECRET',
    );
  });
});
