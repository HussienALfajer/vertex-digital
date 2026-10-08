import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import { telegramMessages } from '../schema/index.js';
import { queueTelegramMessage, TELEGRAM_SEND_OPTIONS } from './index.js';

/*
 * The bot's outbox (S05 F07) and the one-at-a-time indexes of the Telegram tables. The live link
 * and the open prompt are shared by the whole database, so those tests run in rolled-back
 * transactions and never disturb the API's tests.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;

afterAll(() => connection.close());

function recordingJobs(): JobSender & {
  sent: { queue: string; data: object; options?: object }[];
} {
  const sent: { queue: string; data: object; options?: object }[] = [];
  return { sent, send: async (_tx, queue, data, options) => sent.push({ queue, data, options }) };
}

async function rolledBack(work: (client: pg.PoolClient) => Promise<void>) {
  const client = await connection.pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('queueTelegramMessage', () => {
  it('writes the row and its telegram.send job in the transaction', async () => {
    const jobs = recordingJobs();
    const id = await db.transaction((tx) =>
      queueTelegramMessage(tx, jobs, { kind: 'bot_reply', params: { reply: 'help' }, chatId: 77 }),
    );
    expect(id).not.toBeNull();
    const [row] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.id, id as string));
    expect(row).toMatchObject({
      kind: 'bot_reply',
      params: { reply: 'help' },
      chatId: 77,
      status: 'pending',
      attempts: 0,
      dedupeKey: null,
    });
    expect(jobs.sent).toEqual([
      { queue: 'telegram.send', data: { messageId: id }, options: TELEGRAM_SEND_OPTIONS },
    ]);
  });

  it('writes a dedupe key once and queues nothing the second time', async () => {
    const jobs = recordingJobs();
    const message = {
      kind: 'switch_changed',
      params: { switch: 'deposits_stopped', value: true, channel: 'admin' },
      dedupeKey: `switch:${newId()}`,
    } as const;
    const first = await db.transaction((tx) => queueTelegramMessage(tx, jobs, message));
    const second = await db.transaction((tx) => queueTelegramMessage(tx, jobs, message));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(jobs.sent).toHaveLength(1);
  });

  it('refuses parameters that do not match the kind', async () => {
    await expect(
      db.transaction((tx) =>
        queueTelegramMessage(tx, recordingJobs(), {
          kind: 'switch_changed',
          params: { switch: 'nothing' } as never,
        }),
      ),
    ).rejects.toThrow();
  });

  it('leaves no row when the transaction rolls back', async () => {
    const jobs = recordingJobs();
    let id: string | null = null;
    await expect(
      db.transaction(async (tx) => {
        id = await queueTelegramMessage(tx, jobs, { kind: 'test', params: {} });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    const rows = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.id, id as unknown as string));
    expect(rows).toEqual([]);
  });
});

describe('Telegram tables', () => {
  it('keep at most one live link (rule TG3)', async () => {
    await rolledBack(async (client) => {
      await client.query(`update telegram_links set unlinked_at = now() where unlinked_at is null`);
      const link = `insert into telegram_links (id, admin_id, chat_id, telegram_user_id)
                    values ($1, $2, 1, 1)`;
      await client.query(link, [newId(), newId()]);
      await expect(client.query(link, [newId(), newId()])).rejects.toThrow(
        /telegram_links_live_idx/,
      );
    });
  });

  it('keep at most one open prompt (rule TG7)', async () => {
    await rolledBack(async (client) => {
      await client.query(`update telegram_prompts set closed_at = now() where closed_at is null`);
      const prompt = `insert into telegram_prompts (id, kind, data, expires_at)
                      values ($1, 'stop_confirm', '{"scope":"both"}', now() + interval '10 minutes')`;
      await client.query(prompt, [newId()]);
      await expect(client.query(prompt, [newId()])).rejects.toThrow(/telegram_prompts_open_idx/);
    });
  });

  it('store a link code as a 32-byte digest, once', async () => {
    const code = `insert into telegram_link_codes (id, admin_id, code_sha256, expires_at)
                  values ($1, $2, $3, now())`;
    await rolledBack(async (client) => {
      await expect(client.query(code, [newId(), newId(), Buffer.alloc(16)])).rejects.toThrow(
        /telegram_link_codes_sha256_check/,
      );
    });
    await rolledBack(async (client) => {
      const digest = Buffer.alloc(32, 7);
      await client.query(code, [newId(), newId(), digest]);
      await expect(client.query(code, [newId(), newId(), digest])).rejects.toThrow(/unique/);
    });
  });

  it('accept an update id once (rule TG5)', async () => {
    await rolledBack(async (client) => {
      const update = `insert into telegram_updates (update_id) values ($1)`;
      const updateId = Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1e9);
      await client.query(update, [updateId]);
      await expect(client.query(update, [updateId])).rejects.toThrow(/telegram_updates_pkey/);
    });
  });
});
