import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';

const DATABASE_URL = 'postgres://app:pw@127.0.0.1:5432/vertex_digital';

describe('worker environment', () => {
  it('turns Telegram off for empty values and the .env.example placeholder', () => {
    expect(parseEnv({ DATABASE_URL }).TELEGRAM_BOT_TOKEN).toBeUndefined();
    const env = parseEnv({
      DATABASE_URL,
      TELEGRAM_BOT_TOKEN: '000000000:replace-me',
      TELEGRAM_WEBHOOK_SECRET: '',
      SENTRY_DSN: '',
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('writes bot messages to files by default; the Bot API needs the webhook with the token', () => {
    expect(parseEnv({ DATABASE_URL })).toMatchObject({
      TELEGRAM_TRANSPORT: 'log',
      TELEGRAM_LOG_DIR: './.data/telegram',
    });
    // `log` needs nothing else, even with a token.
    expect(parseEnv({ DATABASE_URL, TELEGRAM_BOT_TOKEN: '123:abc' }).TELEGRAM_BOT_TOKEN).toBe(
      '123:abc',
    );
    // `api` without a token sends nothing: the bot is not configured.
    expect(
      parseEnv({ DATABASE_URL, TELEGRAM_TRANSPORT: 'api' }).TELEGRAM_BOT_TOKEN,
    ).toBeUndefined();
    const api = { DATABASE_URL, TELEGRAM_TRANSPORT: 'api', TELEGRAM_BOT_TOKEN: '123:abc' };
    expect(() => parseEnv(api)).toThrow('TELEGRAM_WEBHOOK_URL');
    const webhook = {
      TELEGRAM_WEBHOOK_SECRET: 's'.repeat(40),
      TELEGRAM_WEBHOOK_URL: 'https://digital.vertexmedia.pro/api/webhooks/telegram',
    };
    expect(parseEnv({ ...api, ...webhook })).toMatchObject(webhook);
    expect(() =>
      parseEnv({
        ...api,
        ...webhook,
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1/api/webhooks/telegram',
      }),
    ).toThrow('TELEGRAM_WEBHOOK_URL');
    expect(() => parseEnv({ ...api, ...webhook, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(
      'TELEGRAM_WEBHOOK_SECRET',
    );
  });

  it('checks the USDT addresses at boot (S04 edge case 17), placeholders counting as unset', () => {
    const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const bsc = '0x55d398326f99059fF775485246999027B3197955';
    expect(
      parseEnv({ DATABASE_URL, USDT_TRC20_ADDRESS: ` ${tron} `, USDT_BEP20_ADDRESS: bsc }),
    ).toMatchObject({ USDT_TRC20_ADDRESS: tron, USDT_BEP20_ADDRESS: bsc, CHAIN_READER: 'fake' });
    const unset = parseEnv({
      DATABASE_URL,
      USDT_TRC20_ADDRESS: 'T000000000000000000000000000000000',
      USDT_BEP20_ADDRESS: '',
    });
    expect([unset.USDT_TRC20_ADDRESS, unset.USDT_BEP20_ADDRESS]).toEqual([undefined, undefined]);
    expect(() => parseEnv({ DATABASE_URL, USDT_TRC20_ADDRESS: `${tron.slice(0, -1)}u` })).toThrow(
      'USDT_TRC20_ADDRESS',
    );
    expect(() => parseEnv({ DATABASE_URL, USDT_BEP20_ADDRESS: bsc.replace('fF', 'Ff') })).toThrow(
      'USDT_BEP20_ADDRESS',
    );
  });

  it('refuses the fake chain in production, and live readers without their provider', () => {
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'mailbox@example.com',
      SMTP_PASSWORD: 'secret',
    };
    expect(() => parseEnv(production)).toThrow('CHAIN_READER');
    // Production sends through the Bot API unless told otherwise, and never writes files.
    expect(parseEnv({ ...production, CHAIN_READER: 'live' }).TELEGRAM_TRANSPORT).toBe('api');
    expect(() =>
      parseEnv({ ...production, CHAIN_READER: 'live', TELEGRAM_TRANSPORT: 'log' }),
    ).toThrow('TELEGRAM_TRANSPORT');
    expect(parseEnv({ ...production, CHAIN_READER: 'live' }).CHAIN_READER).toBe('live');
    expect(parseEnv({ DATABASE_URL, CHAIN_READER: 'stub' }).CHAIN_READER).toBe('fake');
    const live = { DATABASE_URL, CHAIN_READER: 'live' };
    expect(() =>
      parseEnv({ ...live, USDT_TRC20_ADDRESS: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }),
    ).toThrow('TRONGRID_API_KEY');
    expect(() =>
      parseEnv({ ...live, USDT_BEP20_ADDRESS: '0x55d398326f99059fF775485246999027B3197955' }),
    ).toThrow('BSC_RPC_URL');
    expect(() => parseEnv({ ...live, BSC_RPC_URL: 'http://bsc.example.com' })).toThrow(
      'BSC_RPC_URL',
    );
  });
});
