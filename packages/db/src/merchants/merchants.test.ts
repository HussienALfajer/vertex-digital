import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { customers } from '../schema/index.js';
import {
  expireMerchantApplications,
  latestApplication,
  lockApplication,
  type MerchantApplicationRow,
  moveApplication,
} from './applications.js';
import { applicationQueue, merchantPage } from './reads.js';

/*
 * The S20 PR 3 tables and the guards of migration 0081, on PostgreSQL as the app role (the owner
 * only to prove a guard refuses it too): the seeds, applications and their guard, the timeline,
 * settings and photos append-only, profiles, and the moves shared by the API and the worker.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db, pool } = connection;
const jobs = { send: async () => newId() };

afterAll(async () => {
  await Promise.all([connection.close(), owner.close()]);
});

async function customer(phone?: string) {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Customer',
    email: `${id}@test.vertex-digital.local`,
    // A phone of its own: the signals tests count customers sharing a phone.
    phone: phone ?? `+9639${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    emailVerified: true,
  });
  return id;
}

async function version(page = 'merchant_terms') {
  const id = newId();
  await pool.query(
    `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
     values ($1, $2, 1000 + floor(random() * 1e9)::int, 'شروط التاجر', 'النص', 1, $3)`,
    [id, page, newId()],
  );
  return id;
}

async function photo(customerId: string) {
  const id = newId();
  await pool.query(
    `insert into stored_files (id, kind, storage_key, content_type, byte_size, width, height)
     values ($1, 'merchant_shop_photo', $2, 'image/webp', 10, 1, 1)`,
    [id, `merchant_shop_photo/${id.slice(-2)}/${id}.webp`],
  );
  await pool.query('insert into merchant_shop_photos (file_id, customer_id) values ($1, $2)', [
    id,
    customerId,
  ]);
  return id;
}

async function application(customerId: string, values: Record<string, unknown> = {}) {
  const id = newId();
  const row = {
    id,
    customer_id: customerId,
    trade_name: 'محل النور',
    activity: 'phone_shop',
    years_in_business: '1_3',
    governorate: 'aleppo',
    city: 'اعزاز',
    street_address: 'شارع السوق',
    whatsapp: '+963933123456',
    monthly_volume: '500_2000',
    product_interests: '{game_topups}',
    sales_channels: '{shop_counter}',
    terms_version_id: await version(),
    idempotency_key: newId(),
    ...values,
  };
  const columns = Object.keys(row);
  await pool.query(
    `insert into merchant_applications (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return id;
}

const statusOf = async (id: string) =>
  (await pool.query('select status from merchant_applications where id = $1', [id])).rows[0]
    ?.status;

describe('seeds (migration 0081)', () => {
  it('seed the merchant settings and the merchant terms draft', async () => {
    const { rows } = await pool.query(
      `select per_deposit_usd_units, daily_deposit_usd_units, orders_per_ten_minutes,
         reapply_wait_days, info_expiry_days from merchant_settings
       where id = '01a20f6e-3a1c-7b4d-9e2f-5c6d7e8f9a10'`,
    );
    expect(rows).toEqual([
      {
        per_deposit_usd_units: '2000000000',
        daily_deposit_usd_units: '5000000000',
        orders_per_ten_minutes: 60,
        reapply_wait_days: 7,
        info_expiry_days: 7,
      },
    ]);
    const { rows: drafts } = await pool.query(
      "select title from content_page_drafts where page = 'merchant_terms'",
    );
    expect(drafts).toHaveLength(1);
  });
});

describe('merchant applications (MA1–MA4)', () => {
  it('keep one open application per customer', async () => {
    const id = await customer();
    const first = await application(id);
    await expect(application(id)).rejects.toThrow(/merchant_applications_open_idx/);
    await pool.query("update merchant_applications set status = 'withdrawn' where id = $1", [
      first,
    ]);
    await application(id);
  });

  it('start under review, with a merchant terms version and the applicant’s own photo', async () => {
    const id = await customer();
    await expect(application(id, { status: 'approved' })).rejects.toThrow(/starts under review/);
    await expect(application(id, { terms_version_id: await version('terms') })).rejects.toThrow(
      /not a merchant_terms version/,
    );
    const other = await customer();
    await expect(application(id, { shop_photo_file_id: await photo(other) })).rejects.toThrow(
      /not the applicant/,
    );
    await application(id, { shop_photo_file_id: await photo(id) });
  });

  it('check the form: other’s text, choices, links and the approved list', async () => {
    const id = await customer();
    await expect(application(id, { activity: 'other' })).rejects.toThrow(/activity_other_check/);
    await expect(application(id, { product_interests: '{}' })).rejects.toThrow(/choices_check/);
    await expect(application(id, { shop_link: 'http://x.example' })).rejects.toThrow(/text_check/);
    await expect(application(id, { telegram_username: 'a b' })).rejects.toThrow(/telegram_check/);
  });

  it('move only on the transition table and never leave a final status', async () => {
    const id = await application(await customer());
    await expect(
      pool.query("update merchant_applications set status = 'expired' where id = $1", [id]),
    ).rejects.toThrow(/not an allowed transition/);
    await pool.query(
      "update merchant_applications set status = 'info_requested', info_requested_at = now() where id = $1",
      [id],
    );
    await pool.query("update merchant_applications set status = 'withdrawn' where id = $1", [id]);
    await expect(
      pool.query("update merchant_applications set status = 'under_review' where id = $1", [id]),
    ).rejects.toThrow(/is final/);
  });

  it('change the form only on a resubmission, and keep customer and key', async () => {
    const id = await application(await customer());
    await expect(
      pool.query("update merchant_applications set city = 'حلب' where id = $1", [id]),
    ).rejects.toThrow(/only on a resubmission/);
    await expect(
      pool.query('update merchant_applications set idempotency_key = $2 where id = $1', [
        id,
        newId(),
      ]),
    ).rejects.toThrow(/fixed/);
    await pool.query("update merchant_applications set status = 'info_requested' where id = $1", [
      id,
    ]);
    await pool.query(
      "update merchant_applications set status = 'under_review', city = 'حلب' where id = $1",
      [id],
    );
  });

  it('are never deleted, even by the owner', async () => {
    const id = await application(await customer());
    await expect(
      pool.query('delete from merchant_applications where id = $1', [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner.pool.query('delete from merchant_applications where id = $1', [id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('write the event, audit and notification of each move (MA4)', async () => {
    const customerId = await customer();
    const id = await application(customerId);
    const actor = { kind: 'admin' as const, adminId: newId(), ipAddress: null, userAgent: null };
    await db.transaction(async (tx) => {
      const row = (await lockApplication(tx, id)) as MerchantApplicationRow;
      await moveApplication(tx, { jobs }, row, 'request_info', {
        actor,
        message: 'أرسل صورة المحل',
      });
    });
    await expect(
      db.transaction(async (tx) => {
        const row = (await lockApplication(tx, id)) as MerchantApplicationRow;
        await moveApplication(tx, { jobs }, row, 'approve', { actor });
      }),
    ).rejects.toMatchObject({
      code: 'APPLICATION_STATE_INVALID',
      details: { status: 'info_requested' },
    });
    const { rows: events } = await pool.query(
      'select event, message from merchant_application_events where application_id = $1',
      [id],
    );
    expect(events).toEqual([{ event: 'info_requested', message: 'أرسل صورة المحل' }]);
    const { rows: notices } = await pool.query(
      'select event, params from customer_notifications where customer_id = $1',
      [customerId],
    );
    expect(notices).toEqual([
      {
        event: 'merchant_info_requested',
        params: { applicationId: id, message: 'أرسل صورة المحل' },
      },
    ]);
    const { rows: audits } = await pool.query(
      'select action, reason from audit_entries where entity_id = $1',
      [id],
    );
    expect(audits).toEqual([
      { action: 'merchant_application.info_requested', reason: 'أرسل صورة المحل' },
    ]);
    expect((await latestApplication(db, customerId))?.status).toBe('info_requested');
  });

  it('expire unanswered requests once, measured from the request (MA4, edge case 14)', async () => {
    const customerId = await customer();
    const id = await application(customerId);
    await pool.query(
      `update merchant_applications set status = 'info_requested',
         info_requested_at = now() - interval '8 days' where id = $1`,
      [id],
    );
    const fresh = await application(await customer());
    await pool.query(
      `update merchant_applications set status = 'info_requested',
         info_requested_at = now() - interval '6 days' where id = $1`,
      [fresh],
    );
    expect(await expireMerchantApplications(db, { jobs })).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe('expired');
    expect(await statusOf(fresh)).toBe('info_requested');
    expect(await expireMerchantApplications(db, { jobs })).toBe(0);
    const { rows } = await pool.query(
      `select a.actor_kind, a.channel from audit_entries a
       where a.entity_id = $1 and a.action = 'merchant_application.expired'`,
      [id],
    );
    expect(rows).toEqual([{ actor_kind: 'system', channel: 'worker' }]);
  });

  it('list the queue oldest first under review, with the applicant’s flags (MA8)', async () => {
    const phone = `+9639${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await customer(phone);
    const id = await application(await customer(phone));
    const page = await applicationQueue(db, { status: 'under_review', after: null, limit: 500 });
    const row = page.find((item) => item.id === id);
    expect(row).toMatchObject({ frozen: false, newAccount: true });
    expect(row?.sharedPhone).toBeGreaterThanOrEqual(1);
    const times = page.map((item) => item.submittedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('append-only merchant tables', () => {
  it.each([
    ['merchant_settings', 'update merchant_settings set reapply_wait_days = 1'],
    ['merchant_application_events', "update merchant_application_events set message = 'x'"],
    ['merchant_shop_photos', 'update merchant_shop_photos set created_at = now()'],
  ])('%s refuses changes for the app role and the owner', async (_table, statement) => {
    await expect(pool.query(statement)).rejects.toThrow(/permission denied/);
    await expect(owner.pool.query(statement)).rejects.toThrow(/append-only/);
  });

  it('refuse settings outside their bounds', async () => {
    await expect(
      pool.query(
        `insert into merchant_settings (id, per_deposit_usd_units, daily_deposit_usd_units,
           orders_per_ten_minutes, reapply_wait_days, info_expiry_days)
         values ($1, 6000000000, 5000000000, 60, 7, 7)`,
        [newId()],
      ),
    ).rejects.toThrow(/merchant_settings_bounds_check/);
  });
});

describe('merchant profiles', () => {
  it('take only a merchant terms version and are never deleted', async () => {
    const id = await customer();
    await pool.query(
      `insert into merchant_profiles (customer_id, trade_name, governorate, city, granted_at)
       values ($1, 'محل', 'damascus', 'دمشق', now())`,
      [id],
    );
    await expect(
      pool.query('update merchant_profiles set terms_version_id = $2 where customer_id = $1', [
        id,
        await version('privacy'),
      ]),
    ).rejects.toThrow(/not a merchant_terms version/);
    await pool.query('update merchant_profiles set terms_version_id = $2 where customer_id = $1', [
      id,
      await version(),
    ]);
    await expect(
      owner.pool.query('delete from merchant_profiles where customer_id = $1', [id]),
    ).rejects.toThrow(/never deleted/);
    // A profile of a customer who is not a merchant is not listed.
    const page = await merchantPage(db, { q: null, listId: null, after: null, limit: 500 });
    expect(page.some((row) => row.customerId === id)).toBe(false);
  });
});
