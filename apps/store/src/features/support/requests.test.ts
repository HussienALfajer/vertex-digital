import { createChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { describe, expect, it } from 'vitest';
import {
  attachmentUrl,
  closeTicket,
  findOpenTicket,
  getTicket,
  listTickets,
  openTicket,
  replyToTicket,
} from './requests';

type Call = { url: string; init?: RequestInit };

/** A fetch that answers each call with the next response and records what was sent. */
function fetcher(...answers: [status: number, body: unknown][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const header = (call: Call | undefined, name: string) =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

const TICKET_ID = '0199f000-0000-7000-8000-000000000001';
const ORDER_ID = '0199f000-0000-7000-8000-0000000000a1';
const DEPOSIT_ID = '0199f000-0000-7000-8000-0000000000d1';

const summary = (changes: Record<string, unknown>) => ({
  id: TICKET_ID,
  status: 'open',
  order: null,
  deposit: null,
  ...changes,
});

describe('listTickets and getTicket', () => {
  it('reads a page with its cursor and limit', async () => {
    const { fetch, calls } = fetcher([200, { items: [], nextCursor: null }]);
    await listTickets({ cursor: 'c1', limit: 50 }, fetch);
    expect(calls[0]?.url).toBe('/api/support/tickets?cursor=c1&limit=50');
  });

  it('reads the first page without a query', async () => {
    const { fetch, calls } = fetcher([200, { items: [], nextCursor: null }]);
    await listTickets({}, fetch);
    expect(calls[0]?.url).toBe('/api/support/tickets');
  });

  it('answers NOT_FOUND for another customer’s ticket', async () => {
    const { fetch, calls } = fetcher([404, { code: 'NOT_FOUND' }]);
    expect(await getTicket(TICKET_ID, fetch)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(calls[0]?.url).toBe(`/api/support/tickets/${TICKET_ID}`);
  });

  it('serves an attachment through its ticket', () => {
    expect(attachmentUrl(TICKET_ID, 'f1')).toBe(`/api/support/tickets/${TICKET_ID}/attachments/f1`);
  });
});

describe('openTicket (TK1)', () => {
  it('solves the challenge, then sends the fields and images as multipart with the key', async () => {
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 10,
      counter: 1,
      deriveKey,
      hmacSignatureSecret: 'test-only-hmac-key',
    });
    const { fetch, calls } = fetcher([200, challenge], [201, { id: TICKET_ID }]);
    const image = new Blob(['png'], { type: 'image/png' });
    const result = await openTicket(
      {
        category: 'order',
        orderId: ORDER_ID,
        depositId: DEPOSIT_ID,
        subject: 'لم يصل الشحن',
        body: 'مرحباً',
      },
      [image, image],
      'key-1',
      fetch,
    );
    expect(result).toEqual({ ok: true, data: { id: TICKET_ID } });
    expect(calls[1]?.url).toBe('/api/support/tickets');
    expect(header(calls[1], 'idempotency-key')).toBe('key-1');
    expect(header(calls[1], 'x-altcha')).toBeTruthy();
    const body = calls[1]?.init?.body as FormData;
    expect(body.get('category')).toBe('order');
    expect(body.get('orderId')).toBe(ORDER_ID);
    // Only the link of the ticket's type goes (TICKET_LINK_INVALID otherwise).
    expect(body.has('depositId')).toBe(false);
    expect(body.get('subject')).toBe('لم يصل الشحن');
    expect(body.getAll('files')).toHaveLength(2);
  });
});

describe('replyToTicket and closeTicket', () => {
  it('sends a message with its key and images', async () => {
    const { fetch, calls } = fetcher([201, { id: TICKET_ID }]);
    await replyToTicket(TICKET_ID, 'شكراً', [new Blob(['x'])], 'key-2', fetch);
    expect(calls[0]?.url).toBe(`/api/support/tickets/${TICKET_ID}/messages`);
    expect(header(calls[0], 'idempotency-key')).toBe('key-2');
    const body = calls[0]?.init?.body as FormData;
    expect(body.get('body')).toBe('شكراً');
    expect(body.getAll('files')).toHaveLength(1);
  });

  it('answers TICKET_CLOSED past 7 days', async () => {
    const { fetch } = fetcher([409, { code: 'TICKET_CLOSED' }]);
    expect(await replyToTicket(TICKET_ID, 'x', [], 'k', fetch)).toEqual({
      ok: false,
      reason: 'TICKET_CLOSED',
    });
  });

  it('closes', async () => {
    const { fetch, calls } = fetcher([200, { id: TICKET_ID }]);
    await closeTicket(TICKET_ID, fetch);
    expect(calls[0]?.url).toBe(`/api/support/tickets/${TICKET_ID}/close`);
    expect(calls[0]?.init?.method).toBe('POST');
  });
});

describe('findOpenTicket', () => {
  it('finds the open ticket about an order, never a closed one', async () => {
    const { fetch, calls } = fetcher([
      200,
      {
        items: [
          summary({ id: 'closed', status: 'closed', order: { id: ORDER_ID, number: 'VO-1' } }),
          summary({ id: 'other', order: { id: 'x', number: 'VO-2' } }),
          summary({ id: 'open', status: 'answered', order: { id: ORDER_ID, number: 'VO-1' } }),
        ],
        nextCursor: null,
      },
    ]);
    const result = await findOpenTicket({ orderId: ORDER_ID }, fetch);
    expect(result.ok && result.data?.id).toBe('open');
    expect(calls[0]?.url).toBe('/api/support/tickets?limit=50');
  });

  it('answers null when the deposit has none', async () => {
    const { fetch } = fetcher([
      200,
      {
        items: [summary({ status: 'closed', deposit: { id: DEPOSIT_ID, referenceCode: 'VD-1' } })],
        nextCursor: null,
      },
    ]);
    expect(await findOpenTicket({ depositId: DEPOSIT_ID }, fetch)).toEqual({
      ok: true,
      data: null,
    });
  });

  it('passes a failure on', async () => {
    const { fetch } = fetcher([401, { code: 'UNAUTHORIZED' }]);
    expect(await findOpenTicket({ depositId: DEPOSIT_ID }, fetch)).toEqual({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
  });
});
