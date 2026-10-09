import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { STORE_REVALIDATE_RETRIES } from '@vertex-digital/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { StoreRevalidateJob } from '../src/jobs/store/revalidate.job.js';

/*
 * `store.revalidate` (S09 rule SF4) against a local server standing in for the store's
 * `/_internal/revalidate` route: nothing here reaches the real store.
 */

const SECRET = 's'.repeat(48);
const received: { method?: string; url?: string; authorization?: string }[] = [];
let status = 204;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    received.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.statusCode = status;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  status = 204;
});

const pgBoss = { work: async () => {} } as unknown as PgBossService;
const job = () =>
  new StoreRevalidateJob(pgBoss, { STORE_PORT: port, STORE_REVALIDATE_SECRET: SECRET });

describe('store.revalidate (S09 rule SF4)', () => {
  it('posts to the loopback route with the bearer secret', async () => {
    expect(await job().handle(0)).toBe(true);
    expect(received).toEqual([
      { method: 'POST', url: '/_internal/revalidate', authorization: `Bearer ${SECRET}` },
    ]);
  });

  it('throws for a retry, then only warns on the last attempt (no alert)', async () => {
    status = 401;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await expect(job().handle(0)).rejects.toThrow('The store answered 401');
      await expect(job().handle(STORE_REVALIDATE_RETRIES - 1)).rejects.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(await job().handle(STORE_REVALIDATE_RETRIES)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('after 4 attempts');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails when the store is not listening (restarting, edge case 19)', async () => {
    const down = new StoreRevalidateJob(pgBoss, { STORE_PORT: 1, STORE_REVALIDATE_SECRET: SECRET });
    await expect(down.handle(0)).rejects.toThrow();
  });
});
