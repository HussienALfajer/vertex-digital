import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';

const DATABASE_URL = 'postgres://app:pw@127.0.0.1:5432/vertex_digital';

describe('worker environment', () => {
  it('turns Telegram off for empty values and the .env.example placeholder', () => {
    expect(parseEnv({ DATABASE_URL }).TELEGRAM_BOT_TOKEN).toBeUndefined();
    const env = parseEnv({
      DATABASE_URL,
      TELEGRAM_BOT_TOKEN: '000000000:replace-me',
      TELEGRAM_ALERTS_CHAT_ID: '',
      SENTRY_DSN: '',
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('needs the token and the chat together', () => {
    expect(() => parseEnv({ DATABASE_URL, TELEGRAM_BOT_TOKEN: '123:abc' })).toThrow(
      'TELEGRAM_ALERTS_CHAT_ID',
    );
    expect(
      parseEnv({ DATABASE_URL, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALERTS_CHAT_ID: '-100' }),
    ).toMatchObject({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALERTS_CHAT_ID: '-100' });
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
