import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_SWITCH_DEFAULTS } from '@vertex-digital/contracts';
import {
  createDatabase,
  type JobSender,
  newId,
  queueTelegramMessage,
  type TelegramMessageInput,
  type Transaction,
  telegramLinks,
  telegramMessages,
} from '@vertex-digital/db';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { MAX_TELEGRAM_ATTEMPTS, SendTelegramJob } from '../src/jobs/telegram/send.job.js';
import { TelegramApiError, TelegramBot } from '../src/telegram/bot-api.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';
import { TelegramWebhookSetup } from '../src/telegram/webhook-setup.js';

/*
 * The bot's sending side (S05 F07): the Bot API client against a local fake server, the Arabic
 * messages, the `telegram.send` job and the webhook registration. Nothing calls Telegram. The live
 * link is shared by the whole database, so the job's tests run inside a transaction that is
 * rolled back, and never disturb the API's tests.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;

interface Received {
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let apiUrl: string;
let received: Received[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, result: {} } };

beforeAll(async () => {
  server = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      received.push({ path: request.url ?? '', body: JSON.parse(data) });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await connection.close();
});

beforeEach(() => {
  received = [];
  reply = { status: 200, body: { ok: true, result: { message_id: 321 } } };
});

/** `null`: no token. */
const apiBot = (botToken: string | null = '123:abc', url = apiUrl) =>
  new TelegramBot({ transport: 'api', botToken: botToken ?? undefined, apiUrl: url, logDir: '' });

const LINKS = { admin: 'http://127.0.0.1:5173' };
const ENV = { ADMIN_URL: LINKS.admin } as Env;

const logDir = () => mkdtemp(join(tmpdir(), 'vertex-digital-telegram-test-'));

describe('the Bot API client', () => {
  it('posts the method and its payload, and answers the result', async () => {
    expect(await apiBot().call('sendMessage', { chat_id: 5, text: 'hi' })).toEqual({
      message_id: 321,
    });
    expect(received).toEqual([
      { path: '/bot123:abc/sendMessage', body: { chat_id: 5, text: 'hi' } },
    ]);
  });

  it('turns a refusal into a TelegramApiError with retry_after, never the token', async () => {
    reply = {
      status: 429,
      body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } },
    };
    const limited = await apiBot()
      .call('sendMessage', {})
      .catch((error: unknown) => error);
    expect(limited).toMatchObject({ status: 429, retryAfter: 7 });
    expect((limited as Error).message).toBe('HTTP 429: Too Many Requests');

    reply = { status: 502, body: 'not json' };
    expect(
      await apiBot()
        .call('sendMessage', {})
        .catch((error: unknown) => error),
    ).toMatchObject({
      status: 502,
      message: 'HTTP 502: Unexpected reply',
    });

    const unreachable = await apiBot('123:secret-token', 'http://127.0.0.1:9')
      .call('sendMessage', {})
      .catch((error: unknown) => error);
    expect(unreachable).toBeInstanceOf(TelegramApiError);
    expect((unreachable as TelegramApiError).status).toBe(0);
    expect(String((unreachable as Error).message)).not.toContain('secret-token');
  });

  it('is not configured over the Bot API without a token', async () => {
    const bot = apiBot(null);
    expect(bot.configured).toBe(false);
    await expect(bot.call('sendMessage', {})).rejects.toThrow('not set');
    expect(received).toEqual([]);
  });

  it('writes each call as a JSON file in log mode, and calls nothing', async () => {
    const dir = await logDir();
    const bot = new TelegramBot({ transport: 'log', apiUrl, logDir: dir });
    expect(bot.configured).toBe(true);
    const result = await bot.call('sendMessage', { chat_id: 5, text: 'مرحبا' });
    expect(result).toEqual({ message_id: expect.any(Number) });
    const [file] = await readdir(dir);
    expect(file).toMatch(/-0001-sendMessage\.json$/);
    expect(JSON.parse(await readFile(join(dir, file as string), 'utf8'))).toEqual({
      method: 'sendMessage',
      chat_id: 5,
      text: 'مرحبا',
    });
    expect(received).toEqual([]);
  });
});

describe('the messages', () => {
  it('announce a switch change with its channel (rule AL2)', () => {
    expect(
      renderTelegramMessage(
        'switch_changed',
        {
          switch: 'deposits_stopped',
          value: true,
          channel: 'admin',
        },
        LINKS,
      ).text,
    ).toBe('⛔ أُوقفت الإيداعات (من اللوحة)');
    expect(
      renderTelegramMessage(
        'switch_changed',
        {
          switch: 'purchases_stopped',
          value: false,
          channel: 'telegram',
        },
        LINKS,
      ).text,
    ).toBe('✅ أُعيد فتح الشراء (من تيليجرام)');
    expect(
      renderTelegramMessage(
        'switch_changed',
        {
          switch: 'registration_open',
          value: true,
          channel: 'admin',
        },
        LINKS,
      ).text,
    ).toContain('التسجيل مفتوح الآن');
  });

  it('offer the stop buttons, then confirm and cancel (rules TG6, AL4)', () => {
    const choose = renderTelegramMessage('bot_reply', { reply: 'stop_choose' }, LINKS);
    expect(choose.text).toContain('إعادة الفتح من اللوحة فقط');
    expect(choose.buttons).toEqual([
      [{ text: 'الشراء', data: 'st:purchases' }],
      [{ text: 'الإيداعات', data: 'st:deposits' }],
      [{ text: 'الشراء والإيداعات', data: 'st:both' }],
    ]);
    const promptId = newId();
    expect(
      renderTelegramMessage(
        'bot_reply',
        { reply: 'stop_confirm', promptId, scope: 'deposits' },
        LINKS,
      ),
    ).toEqual({
      text: 'إيقاف الإيداعات؟ إعادة الفتح من اللوحة فقط.',
      buttons: [
        [
          { text: 'تأكيد', data: `ok:${promptId}` },
          { text: 'إلغاء', data: `no:${promptId}` },
        ],
      ],
    });
  });

  it('show the status, the help and the other replies', () => {
    const status = renderTelegramMessage(
      'bot_reply',
      {
        reply: 'status',
        switches: { ...STORE_SWITCH_DEFAULTS, deposits_stopped: true, usdt_bep20_paused: true },
        waiting: 3,
        unmatchedTransfers: 1,
      },
      LINKS,
    ).text;
    expect(status.split('\n')).toEqual([
      'حالة المتجر:',
      'التسجيل: مغلق',
      'الشراء: يعمل',
      'الإيداع: ⛔ متوقف',
      'شام كاش: يعمل',
      'USDT TRC20: يعمل',
      'USDT BEP20: ⏸ متوقف مؤقتاً',
      '',
      'بانتظار المراجعة: 3',
      'تحويلات USDT غير مطابقة: 1',
    ]);
    for (const kind of ['welcome', 'help'] as const) {
      expect(renderTelegramMessage('bot_reply', { reply: kind }, LINKS).text).toContain('/status');
    }
    expect(renderTelegramMessage('bot_reply', { reply: 'invalid_code' }, LINKS).text).toBe(
      'الرمز غير صالح',
    );
    for (const kind of ['stop_already', 'failed'] as const) {
      expect(renderTelegramMessage('bot_reply', { reply: kind }, LINKS).buttons).toBeUndefined();
    }
    expect(renderTelegramMessage('link_changed', {}, LINKS).text).toContain('ألغِ الربط');
    expect(renderTelegramMessage('test', {}, LINKS).text).toContain('اختبار');
  });
});

describe('telegram.send', () => {
  const jobs: JobSender = { send: async () => undefined };
  let resent: { data: object; options: Record<string, unknown> }[];
  const pgBoss = {
    boss: {
      send: async (_queue: string, data: object, options: Record<string, unknown>) => {
        resent.push({ data, options });
        return null;
      },
    },
  } as unknown as PgBossService;

  beforeEach(() => {
    resent = [];
  });

  /** Runs `work` in a transaction that is always rolled back: the live link stays untouched. */
  async function isolated(work: (tx: Transaction) => Promise<void>): Promise<void> {
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(telegramLinks)
          .set({ unlinkedAt: new Date() })
          .where(isNull(telegramLinks.unlinkedAt));
        await work(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }

  const queue = (tx: Transaction, input?: Partial<TelegramMessageInput<'bot_reply'>>) =>
    queueTelegramMessage(tx, jobs, {
      kind: 'bot_reply',
      params: { reply: 'stop_choose' },
      ...input,
    }) as Promise<string>;

  const rowOf = async (tx: Transaction, id: string) =>
    (await tx.select().from(telegramMessages).where(eq(telegramMessages.id, id)))[0];

  it('sends to the given chat with its buttons, once', async () => {
    const dir = await logDir();
    const job = new SendTelegramJob(
      pgBoss,
      new TelegramBot({ transport: 'log', apiUrl, logDir: dir }),
      db,
      ENV,
    );
    await isolated(async (tx) => {
      const id = await queue(tx, { chatId: 9001 });
      const now = new Date('2026-10-08T12:00:00Z');
      expect(await job.send(id, now, tx)).toBe('sent');
      expect(await job.send(id, now, tx)).toBe('none');
      expect(await rowOf(tx, id)).toMatchObject({
        status: 'sent',
        attempts: 1,
        sentAt: now,
        lastError: null,
        telegramMessageId: expect.any(Number),
      });
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const sent = JSON.parse(await readFile(join(dir, files[0] as string), 'utf8'));
      expect(sent).toMatchObject({
        method: 'sendMessage',
        chat_id: 9001,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'الشراء', callback_data: 'st:purchases' }],
            [{ text: 'الإيداعات', callback_data: 'st:deposits' }],
            [{ text: 'الشراء والإيداعات', callback_data: 'st:both' }],
          ],
        },
      });
    });
  });

  it('sends to the live link at send time, and skips with no link (edge case 2)', async () => {
    const job = new SendTelegramJob(pgBoss, apiBot(), db, ENV);
    await isolated(async (tx) => {
      const unlinked = await queue(tx);
      expect(await job.send(unlinked, new Date(), tx)).toBe('skipped');
      expect((await rowOf(tx, unlinked))?.status).toBe('skipped');
      expect(received).toEqual([]);

      await tx
        .insert(telegramLinks)
        .values({ id: newId(), adminId: newId(), chatId: 7007, telegramUserId: 7007 });
      const linked = await queue(tx);
      expect(await job.send(linked, new Date(), tx)).toBe('sent');
      expect(received[0]?.body).toMatchObject({ chat_id: 7007 });
      expect((await rowOf(tx, linked))?.telegramMessageId).toBe(321);
    });
  });

  it('skips while the bot is not configured', async () => {
    const job = new SendTelegramJob(pgBoss, apiBot(null), db, ENV);
    await isolated(async (tx) => {
      const id = await queue(tx, { chatId: 1 });
      expect(await job.send(id, new Date(), tx)).toBe('skipped');
    });
  });

  it('waits retry_after on a 429 with a delayed job, without throwing', async () => {
    const job = new SendTelegramJob(pgBoss, apiBot(), db, ENV);
    reply = {
      status: 429,
      body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } },
    };
    await isolated(async (tx) => {
      const id = await queue(tx, { chatId: 1 });
      expect(await job.send(id, new Date(), tx)).toBe('retry');
      expect(await rowOf(tx, id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'TelegramApiError: HTTP 429: Too Many Requests',
      });
      expect(resent).toEqual([
        {
          data: { messageId: id },
          options: expect.objectContaining({ startAfter: 12, retryLimit: 5 }),
        },
      ]);
    });
  });

  it('fails at once without retry when the admin blocked the bot (403)', async () => {
    const job = new SendTelegramJob(pgBoss, apiBot(), db, ENV);
    reply = {
      status: 403,
      body: { ok: false, description: 'Forbidden: bot was blocked by the user' },
    };
    await isolated(async (tx) => {
      const id = await queue(tx, { chatId: 1 });
      expect(await job.send(id, new Date(), tx)).toBe('failed');
      expect(await rowOf(tx, id)).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: expect.stringContaining('blocked'),
      });
      expect(await job.send(id, new Date(), tx)).toBe('none');
      expect(resent).toEqual([]);
    });
  });

  it('throws other failures for pg-boss to retry, and fails after the last attempt', async () => {
    const job = new SendTelegramJob(pgBoss, apiBot(), db, ENV);
    reply = { status: 500, body: { ok: false, description: 'Internal Server Error' } };
    await isolated(async (tx) => {
      const id = await queue(tx, { chatId: 1 });
      await expect(job.send(id, new Date(), tx)).rejects.toThrow('HTTP 500');
      expect(await rowOf(tx, id)).toMatchObject({ status: 'pending', attempts: 1 });
      await tx
        .update(telegramMessages)
        .set({ attempts: MAX_TELEGRAM_ATTEMPTS - 1 })
        .where(eq(telegramMessages.id, id));
      await expect(job.send(id, new Date(), tx)).rejects.toThrow('HTTP 500');
      expect(await rowOf(tx, id)).toMatchObject({
        status: 'failed',
        attempts: MAX_TELEGRAM_ATTEMPTS,
      });
      // A 429 on the last attempt fails too, instead of waiting again.
      reply = {
        status: 429,
        body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } },
      };
      const last = await queue(tx, { chatId: 1 });
      await tx
        .update(telegramMessages)
        .set({ attempts: MAX_TELEGRAM_ATTEMPTS - 1 })
        .where(eq(telegramMessages.id, last));
      await expect(job.send(last, new Date(), tx)).rejects.toThrow('HTTP 429');
      expect((await rowOf(tx, last))?.status).toBe('failed');
      expect(resent).toEqual([]);
    });
  });
});

describe('the webhook registration (rule TG2)', () => {
  const env = {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_URL: 'https://digital.vertexmedia.pro/api/webhooks/telegram',
    TELEGRAM_WEBHOOK_SECRET: 's'.repeat(40),
  } as Env;

  it('sets the webhook with its secret and the two update kinds', async () => {
    await new TelegramWebhookSetup(apiBot(), env).onApplicationBootstrap();
    expect(received).toEqual([
      {
        path: '/bot123:abc/setWebhook',
        body: {
          url: env.TELEGRAM_WEBHOOK_URL,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
        },
      },
    ]);
  });

  it('does nothing in log mode or without a token, and survives a failure', async () => {
    const dir = await logDir();
    await new TelegramWebhookSetup(
      new TelegramBot({ transport: 'log', apiUrl, logDir: dir }),
      env,
    ).onApplicationBootstrap();
    await new TelegramWebhookSetup(apiBot(null), {
      ...env,
      TELEGRAM_BOT_TOKEN: undefined,
    }).onApplicationBootstrap();
    expect(received).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    reply = { status: 401, body: { ok: false, description: 'Unauthorized' } };
    const warn = vi.fn();
    const setup = new TelegramWebhookSetup(apiBot(), env);
    (setup as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    await expect(setup.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });
});
