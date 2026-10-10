import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { customers } from '../schema/index.js';
import { customerSignals } from './reads.js';

/*
 * The S12 tables and the guards of migration 0043, on PostgreSQL as the app role (the owner only
 * to prove a guard refuses it too): notes, limits, sign-ins, tickets, messages, attachments and
 * the support settings. The purchase and archive paths are tested with the orders
 * (`orders/orders.test.ts`, "customer guards (S12)").
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db, pool } = connection;
const DIGITS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

afterAll(async () => {
  await Promise.all([connection.close(), owner.close()]);
});

async function customer(phone = '+963900000001') {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Customer',
    email: `${id}@test.vertex-digital.local`,
    phone,
    emailVerified: true,
  });
  return id;
}

const ticketNumber = () =>
  `VT-${Array.from({ length: 6 }, () => DIGITS[Math.floor(Math.random() * DIGITS.length)]).join('')}`;

async function ticket(customerId: string, values: Record<string, unknown> = {}) {
  const id = newId();
  const row = {
    id,
    number: ticketNumber(),
    customer_id: customerId,
    category: 'account',
    subject: 'سؤال عن حسابي',
    status: 'open',
    opened_by: 'customer',
    ...values,
  };
  const columns = Object.keys(row);
  await pool.query(
    `insert into support_tickets (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return id;
}

async function message(ticketId: string) {
  const id = newId();
  await pool.query(
    `insert into support_messages (id, ticket_id, author, body, idempotency_key)
     values ($1, $2, 'customer', 'مرحبا', $3)`,
    [id, ticketId, newId()],
  );
  return id;
}

async function file() {
  const id = newId();
  await pool.query(
    `insert into stored_files (id, kind, storage_key, content_type, byte_size, width, height)
     values ($1, 'ticket_attachment', $2, 'image/webp', 10, 1, 1)`,
    [id, `ticket_attachment/${id.slice(-2)}/${id}.webp`],
  );
  return id;
}

describe('customer notes (SN2)', () => {
  it('keep one pinned, unarchived note per customer', async () => {
    const id = await customer();
    const insert = (pinned: boolean) =>
      pool.query(
        'insert into customer_notes (id, customer_id, body, pinned) values ($1, $2, $3, $4)',
        [newId(), id, 'ملاحظة', pinned],
      );
    await insert(true);
    await insert(false);
    await expect(insert(true)).rejects.toThrow(/customer_notes_one_pinned_idx/);
    await pool.query(
      'update customer_notes set archived_at = now() where customer_id = $1 and pinned',
      [id],
    );
    await insert(true);
  });

  it('refuse an empty or long body', async () => {
    const id = await customer();
    for (const body of ['', 'a'.repeat(2001)]) {
      await expect(
        pool.query('insert into customer_notes (id, customer_id, body) values ($1, $2, $3)', [
          newId(),
          id,
          body,
        ]),
      ).rejects.toThrow(/customer_notes_body_check/);
    }
  });

  it('never change their body or customer, and are never deleted, even by the owner', async () => {
    const id = await customer();
    const note = newId();
    await pool.query('insert into customer_notes (id, customer_id, body) values ($1, $2, $3)', [
      note,
      id,
      'ملاحظة',
    ]);
    await pool.query('update customer_notes set pinned = true where id = $1', [note]);
    await expect(pool.query('delete from customer_notes where id = $1', [note])).rejects.toThrow(
      /permission denied/,
    );
    for (const statement of [
      `update customer_notes set body = 'أخرى' where id = $1`,
      `update customer_notes set customer_id = gen_random_uuid() where id = $1`,
      'delete from customer_notes where id = $1',
    ]) {
      await expect(owner.pool.query(statement, [note])).rejects.toThrow(/fixed|never deleted/);
    }
  });
});

describe('customer limits (LM5)', () => {
  it('take positive whole cents up to $100,000, per deposit within the daily', async () => {
    const insert = async (values: (number | null)[]) =>
      pool.query(
        `insert into customer_limits (customer_id, per_deposit_usd_units, daily_deposit_usd_units,
           daily_purchase_usd_units) values ($1, $2, $3, $4)`,
        [await customer(), ...values],
      );
    await insert([null, null, null]);
    await insert([500_000_000, 1_000_000_000, 20_000_000]);
    for (const values of [
      [0, null, null],
      [null, 1_005_000, null],
      [null, null, 100_000_010_000],
      [20_000_000, 10_000_000, null],
    ]) {
      await expect(insert(values)).rejects.toThrow(/customer_limits_/);
    }
  });
});

describe('sign-ins and signals (CS5)', () => {
  it('cap the user agent at 500 characters', async () => {
    const id = await customer();
    await expect(
      pool.query(
        'insert into customer_sign_ins (id, customer_id, user_agent) values ($1, $2, $3)',
        [newId(), id, 'a'.repeat(501)],
      ),
    ).rejects.toThrow(/customer_sign_ins_user_agent_check/);
  });

  it('list other customers sharing the phone or an IP of the last 30 days', async () => {
    const phone = `+9639${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const [me, samePhone, sameIp, oldIp] = [
      await customer(phone),
      await customer(phone),
      await customer(),
      await customer(),
    ];
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
    const signIn = (customerId: string, ago: string) =>
      owner.pool.query(
        `insert into customer_sign_ins (id, customer_id, ip_address, created_at)
         values ($1, $2, $3, now() - $4::interval)`,
        [newId(), customerId, ip, ago],
      );
    await signIn(me, '1 day');
    await signIn(sameIp, '2 days');
    await signIn(oldIp, '31 days');
    const signals = await customerSignals(db, me);
    expect(signals.sharedPhone).toEqual({
      count: 1,
      customers: [expect.objectContaining({ id: samePhone })],
    });
    expect(signals.sharedIp).toEqual({
      count: 1,
      customers: [expect.objectContaining({ id: sameIp, ipAddresses: [ip] })],
    });
  });
});

describe('support tickets (TK1–TK6)', () => {
  it('tie the category to its link and the closed status to its time and closer', async () => {
    const id = await customer();
    for (const values of [
      { category: 'order' },
      { category: 'deposit' },
      { category: 'account', order_id: newId() },
    ]) {
      await expect(ticket(id, values)).rejects.toThrow(/support_tickets_link_check|foreign key/);
    }
    await expect(ticket(id, { status: 'closed' })).rejects.toThrow(/support_tickets_closed_check/);
    await expect(ticket(id, { closed_by: 'system' })).rejects.toThrow(
      /support_tickets_closed_check/,
    );
    await ticket(id, { status: 'closed', closed_at: new Date(), closed_by: 'customer' });
    await expect(ticket(id, { number: 'VT-0OOO1I' })).rejects.toThrow(/support_tickets_number/);
    await expect(ticket(id, { subject: 'ab' })).rejects.toThrow(/support_tickets_subject/);
  });

  it('fix what a ticket is about and are never deleted, even by the owner', async () => {
    const id = await ticket(await customer());
    await pool.query(
      `update support_tickets set status = 'closed', closed_at = now(), closed_by = 'admin'
       where id = $1`,
      [id],
    );
    await expect(pool.query('delete from support_tickets where id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
    for (const statement of [
      `update support_tickets set subject = 'موضوع آخر' where id = $1`,
      `update support_tickets set customer_id = gen_random_uuid() where id = $1`,
      'delete from support_tickets where id = $1',
    ]) {
      await expect(owner.pool.query(statement, [id])).rejects.toThrow(/is fixed|never deleted/);
    }
  });

  it('keep messages and attachments append-only, an image used once, 3 per message', async () => {
    const id = await ticket(await customer());
    const first = await message(id);
    const image = await file();
    const attach = (messageId: string, fileId: string, position: number) =>
      pool.query(
        'insert into support_attachments (message_id, file_id, position) values ($1, $2, $3)',
        [messageId, fileId, position],
      );
    await attach(first, image, 1);
    await expect(attach(await message(id), image, 1)).rejects.toThrow(/file_id_unique/);
    await expect(attach(first, await file(), 4)).rejects.toThrow(/position_check/);
    await expect(attach(first, await file(), 1)).rejects.toThrow(/_pk/);
    for (const [statement, value] of [
      [`update support_messages set body = 'x' where id = $1`, first],
      ['delete from support_messages where id = $1', first],
      ['delete from support_attachments where file_id = $1', image],
    ] as const) {
      await expect(pool.query(statement, [value])).rejects.toThrow(/permission denied/);
      await expect(owner.pool.query(statement, [value])).rejects.toThrow(/append-only/);
    }
  });

  it('make an idempotency key unique across tickets', async () => {
    const key = newId();
    const insert = async () =>
      pool.query(
        `insert into support_messages (id, ticket_id, author, body, idempotency_key)
         values ($1, $2, 'admin', 'رد', $3)`,
        [newId(), await ticket(await customer()), key],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/idempotency_key_unique/);
  });
});

describe('support settings (SC1)', () => {
  it('are one seeded row with a t.me link or none, never deleted', async () => {
    const { rows } = await pool.query('select id from support_settings');
    expect(rows).toEqual([{ id: 1 }]);
    await expect(
      pool.query(`update support_settings set telegram_url = 'https://evil.me/abcde'`),
    ).rejects.toThrow(/telegram_url_check/);
    await expect(pool.query('insert into support_settings (id) values (2)')).rejects.toThrow(
      /one_row_check/,
    );
    await expect(pool.query('delete from support_settings')).rejects.toThrow(/permission denied/);
  });
});
