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
});
