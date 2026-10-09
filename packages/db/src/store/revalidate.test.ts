import { randomUUID } from 'node:crypto';
import { QUEUES, STORE_REVALIDATE_THROTTLE_SECONDS } from '@vertex-digital/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Transaction } from '../client.js';
import { createPgBoss, transactionExecutor } from '../jobs.js';
import type { JobSender } from '../notifications/index.js';
import { queueStoreRevalidate } from './revalidate.js';

const connection = createDatabase(process.env.DATABASE_URL as string);

afterAll(() => connection.close());

describe('queueStoreRevalidate (S09 rule SF4)', () => {
  it('sends one refresh per slot and debounces a later change into the next one', async () => {
    const sent: { queue: string; options: Record<string, unknown> }[] = [];
    const recorder: JobSender = {
      send: async (_tx, queue, _data, options = {}) => {
        sent.push({ queue, options: options as Record<string, unknown> });
        return null;
      },
    };
    await queueStoreRevalidate({} as Transaction, recorder);
    expect(sent).toEqual([
      {
        queue: QUEUES.storeRevalidate,
        options: expect.objectContaining({
          singletonKey: 'catalog',
          singletonSeconds: STORE_REVALIDATE_THROTTLE_SECONDS,
          singletonNextSlot: true,
        }),
      },
    ]);

    // The same options on a queue of the same policy: a change after the slot's refresh was sent
    // gets one more refresh in the next slot, and later changes in that time join it.
    const boss = createPgBoss(process.env.DATABASE_URL as string, {
      supervise: false,
      schedule: false,
    });
    const queue = `test.${randomUUID()}`;
    await boss.start();
    try {
      await boss.createQueue(queue, { policy: 'singleton' });
      // Start early in a slot, so the three sends below never straddle two slots.
      const slotMs = STORE_REVALIDATE_THROTTLE_SECONDS * 1000;
      const into = Date.now() % slotMs;
      if (into > slotMs / 2) await new Promise((done) => setTimeout(done, slotMs - into + 200));
      const send = () =>
        connection.db.transaction((tx) =>
          boss.send(queue, {}, { ...sent[0]?.options, db: transactionExecutor(tx) }),
        );
      const first = await send();
      const second = await send();
      const third = await send();
      expect(first).toEqual(expect.any(String));
      expect(second).toEqual(expect.any(String));
      expect(third).toBeNull();
      const debounced = await boss.getJobById(queue, second as string);
      expect(debounced?.startAfter.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await boss.deleteQueue(queue);
      await boss.stop({ graceful: false });
    }
  }, 20_000);
});
