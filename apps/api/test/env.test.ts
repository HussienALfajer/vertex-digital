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
  ADMIN_AUTH_SECRET: secret('admin'),
  ALTCHA_HMAC_KEY: secret('altcha'),
  SUPPLIER_KEYS_SECRET: Buffer.alloc(32, 7).toString('base64'),
  ORDER_CODES_SECRET: Buffer.alloc(32, 9).toString('base64'),
};

describe('API environment', () => {
  it('derives local secrets and treats the .env.example placeholders as unset', () => {
    const env = parseEnv({
      DATABASE_URL,
      CUSTOMER_AUTH_SECRET: 'replace-with-a-long-random-value',
      SENTRY_DSN: '',
    });
    expect(env.CUSTOMER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ADMIN_AUTH_SECRET).not.toBe(env.CUSTOMER_AUTH_SECRET);
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(parseEnv({ DATABASE_URL }).CUSTOMER_AUTH_SECRET).toBe(env.CUSTOMER_AUTH_SECRET);
  });

  it('takes checksummed USDT addresses, treats empty and old placeholders as unset (S04 rule U1)', () => {
    const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const bsc = '0x55d398326f99059fF775485246999027B3197955';
    expect(
      parseEnv({ DATABASE_URL, USDT_TRC20_ADDRESS: ` ${tron} `, USDT_BEP20_ADDRESS: bsc }),
    ).toMatchObject({ USDT_TRC20_ADDRESS: tron, USDT_BEP20_ADDRESS: bsc });
    const unset = parseEnv({
      DATABASE_URL,
      USDT_TRC20_ADDRESS: 'T000000000000000000000000000000000',
      USDT_BEP20_ADDRESS: '0x0000000000000000000000000000000000000000',
    });
    expect([unset.USDT_TRC20_ADDRESS, unset.USDT_BEP20_ADDRESS]).toEqual([undefined, undefined]);
    expect(parseEnv({ DATABASE_URL, USDT_TRC20_ADDRESS: '' }).USDT_TRC20_ADDRESS).toBeUndefined();
    // One character off fails the checksum: the start stops instead of showing a wrong address.
    expect(() => parseEnv({ DATABASE_URL, USDT_TRC20_ADDRESS: `${tron.slice(0, -1)}u` })).toThrow(
      'USDT_TRC20_ADDRESS',
    );
    expect(() => parseEnv({ DATABASE_URL, USDT_BEP20_ADDRESS: bsc.replace('fF', 'Ff') })).toThrow(
      'USDT_BEP20_ADDRESS',
    );
  });

  it('accepts a complete production environment', () => {
    expect(parseEnv(production)).toMatchObject({
      STORE_URL: 'https://digital.vertexmedia.pro',
      ADMIN_AUTH_SECRET: production.ADMIN_AUTH_SECRET,
    });
  });

  it('derives a 32-byte supplier key locally and refuses the fake supplier in production (S07)', () => {
    const local = parseEnv({ DATABASE_URL });
    expect(Buffer.from(local.SUPPLIER_KEYS_SECRET as string, 'base64')).toHaveLength(32);
    expect(local.SUPPLIER_FAKE_ENABLED).toBe(false);
    expect(parseEnv({ DATABASE_URL, SUPPLIER_FAKE_ENABLED: 'true' }).SUPPLIER_FAKE_ENABLED).toBe(
      true,
    );
    expect(() => parseEnv({ DATABASE_URL, SUPPLIER_KEYS_SECRET: 'c2hvcnQ=' })).toThrow(
      'SUPPLIER_KEYS_SECRET',
    );
    expect(() => parseEnv({ ...production, SUPPLIER_FAKE_ENABLED: 'true' })).toThrow(
      'SUPPLIER_FAKE_ENABLED',
    );
  });

  it('derives a 32-byte order codes key locally, apart from the supplier key (S08 rule C1)', () => {
    const local = parseEnv({ DATABASE_URL });
    expect(Buffer.from(local.ORDER_CODES_SECRET as string, 'base64')).toHaveLength(32);
    expect(local.ORDER_CODES_SECRET).not.toBe(local.SUPPLIER_KEYS_SECRET);
    expect(() => parseEnv({ DATABASE_URL, ORDER_CODES_SECRET: 'c2hvcnQ=' })).toThrow(
      'ORDER_CODES_SECRET',
    );
  });

  it.each([
    'CUSTOMER_AUTH_SECRET',
    'ADMIN_AUTH_SECRET',
    'ALTCHA_HMAC_KEY',
    'SUPPLIER_KEYS_SECRET',
    'ORDER_CODES_SECRET',
  ])('refuses production without %s, or with its placeholder', (key) => {
    expect(() => parseEnv({ ...production, [key]: undefined })).toThrow(key);
    expect(() => parseEnv({ ...production, [key]: 'replace-with-a-long-random-value' })).toThrow(
      key,
    );
  });

  it('refuses http origins and a shared auth secret in production', () => {
    expect(() =>
      parseEnv({ ...production, ADMIN_URL: 'http://digital-admin.vertexmedia.pro' }),
    ).toThrow('ADMIN_URL');
    expect(() =>
      parseEnv({ ...production, ADMIN_AUTH_SECRET: production.CUSTOMER_AUTH_SECRET }),
    ).toThrow('ADMIN_AUTH_SECRET');
  });

  it('configures the Telegram bot with its username; the webhook secret is derived locally (S05 TG1)', () => {
    const local = parseEnv({ DATABASE_URL, TELEGRAM_BOT_USERNAME: 'vertex_digital_bot' });
    expect(local.TELEGRAM_BOT_USERNAME).toBe('vertex_digital_bot');
    expect(local.TELEGRAM_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(parseEnv({ DATABASE_URL, TELEGRAM_BOT_USERNAME: '' }).TELEGRAM_BOT_USERNAME).toBe(
      undefined,
    );
    expect(() => parseEnv({ DATABASE_URL, TELEGRAM_BOT_USERNAME: 'https://t.me/x' })).toThrow(
      'TELEGRAM_BOT_USERNAME',
    );
    expect(() =>
      parseEnv({ DATABASE_URL, TELEGRAM_WEBHOOK_SECRET: `${'x'.repeat(40)} with spaces` }),
    ).toThrow('TELEGRAM_WEBHOOK_SECRET');
    // Production has no derived secret: the bot needs both.
    expect(parseEnv(production).TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(() => parseEnv({ ...production, TELEGRAM_BOT_USERNAME: 'vertex_digital_bot' })).toThrow(
      'TELEGRAM_WEBHOOK_SECRET',
    );
    expect(
      parseEnv({
        ...production,
        TELEGRAM_BOT_USERNAME: 'vertex_digital_bot',
        TELEGRAM_WEBHOOK_SECRET: secret('telegram'),
      }).TELEGRAM_WEBHOOK_SECRET,
    ).toBe(secret('telegram'));
  });

  it('refuses a short secret', () => {
    expect(() => parseEnv({ DATABASE_URL, ADMIN_AUTH_SECRET: 'short' })).toThrow(
      'ADMIN_AUTH_SECRET',
    );
  });
});
