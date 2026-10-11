import { randomUUID } from 'node:crypto';
import {
  CURRENCY_SCALE,
  RECONCILIATION_MANUAL_COOLDOWN_SECONDS,
  RECONCILIATION_MISSING_HOURS,
} from '@vertex-digital/contracts';
import {
  placeBooks,
  reconciliationRuns,
  recordMovement,
  reverseMovement,
  telegramMessages,
} from '@vertex-digital/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, PASSWORD, removeAccounts, seedCustomer, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The reconciliation (S13 rules RN2, RN6–RN8, E4) over HTTP. No worker runs here: a manual run
 * stays `running` until the test marks it failed, as the next real run would (rule RN5). The
 * opening this file records is reversed in `afterAll`, so the place is empty for the next run.
 */

const USD = CURRENCY_SCALE.USD;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const movements: string[] = [];
let settingsBefore: Record<string, unknown>;

const actor = () => ({ adminId: admin.id, ipAddress: null, userAgent: null });

const count = (currency: 'USD' | 'SYP', countedUnits: number, key: string = randomUUID()) =>
  client.post('/api/admin/reconciliation/sham-cash-counts', {
    cookie: admin.cookie,
    body: { currency, countedUnits },
    headers: { 'idempotency-key': key },
  });

const explain = (resultId: string, note = 'Checked with the bank') =>
  client.post(`/api/admin/reconciliation/results/${resultId}/explanation`, {
    cookie: admin.cookie,
    body: { note },
  });

/** Ends any run left `running` (no worker here), as the next real run would after an hour. */
async function endRunning() {
  await test.db
    .update(reconciliationRuns)
    .set({ status: 'failed', finishedAt: new Date(), failure: 'Ended by the API tests' })
    .where(eq(reconciliationRuns.status, 'running'));
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
  await endRunning();
  settingsBefore = await body(
    await client.get('/api/admin/reconciliation/settings', { cookie: admin.cookie }),
  );
});

afterAll(async () => {
  await endRunning();
  for (const id of movements) {
    await test.db.transaction((tx) =>
      reverseMovement(
        tx,
        { movementId: id, idempotencyKey: randomUUID(), reason: 'Test clean-up' },
        actor(),
      ),
    );
  }
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and refuses a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    const id = randomUUID();
    for (const options of [{}, { cookie }]) {
      for (const response of await Promise.all([
        client.get('/api/admin/reconciliation', options),
        client.get('/api/admin/reconciliation/counts', options),
        client.get('/api/admin/reconciliation/runs', options),
        client.get(`/api/admin/reconciliation/runs/${id}`, options),
        client.post('/api/admin/reconciliation/runs', options),
        client.post(`/api/admin/reconciliation/results/${id}/explanation`, {
          ...options,
          body: {},
        }),
        client.post('/api/admin/reconciliation/sham-cash-counts', { ...options, body: {} }),
        client.get('/api/admin/reconciliation/settings', options),
        client.put('/api/admin/reconciliation/settings', { ...options, body: {} }),
      ])) {
        expect(response.status).toBe(401);
      }
    }
  });
});

describe('runs', () => {
  it('queues a manual run, refuses a second while it runs, and limits the rate (RN2)', async () => {
    const [last] = await test.db
      .select({ startedAt: reconciliationRuns.startedAt })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.trigger, 'manual'))
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(1);
    const cooling =
      last !== undefined &&
      Date.now() - last.startedAt.getTime() < RECONCILIATION_MANUAL_COOLDOWN_SECONDS * 1000;
    const start = () => client.post('/api/admin/reconciliation/runs', { cookie: admin.cookie });
    if (cooling) {
      // A run of this file less than 5 minutes ago: the rate refuses first.
      expect(await body(await start())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      return;
    }
    const started = await start();
    expect(started.status).toBe(202);
    const run = await body(started);
    expect(run).toMatchObject({ trigger: 'manual', status: 'running', businessDate: null });
    expect((await auditOf(test.db, run.id as string))[0]).toMatchObject({
      action: 'reconciliation_run.started',
    });
    expect(await body(await start())).toMatchObject({
      status: 409,
      code: 'RECONCILIATION_RUNNING',
    });
    expect(await body(await count('USD', 0))).toMatchObject({
      status: 409,
      code: 'RECONCILIATION_RUNNING',
    });
    const overview = await body(
      await client.get('/api/admin/reconciliation', { cookie: admin.cookie }),
    );
    expect(overview).toMatchObject({
      running: { id: run.id },
      manualAvailableAt: expect.any(String),
    });
    await endRunning();
    expect(await body(await start())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    const detail = await body(
      await client.get(`/api/admin/reconciliation/runs/${run.id}`, { cookie: admin.cookie }),
    );
    expect(detail).toMatchObject({ id: run.id, status: 'failed', results: [] });
  });

  it('lists runs newest first by trigger, and answers 404 for an unknown run', async () => {
    const page = await client.get('/api/admin/reconciliation/runs?trigger=manual&limit=5', {
      cookie: admin.cookie,
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const { items } = (await page.json()) as { items: { trigger: string }[] };
    for (const item of items) expect(item.trigger).toBe('manual');
    for (const id of [randomUUID(), 'not-an-id']) {
      expect(
        await body(
          await client.get(`/api/admin/reconciliation/runs/${id}`, { cookie: admin.cookie }),
        ),
      ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });
});

describe('Sham Cash counts and explanations', () => {
  it('checks a count at once, replays its key, opens a mismatch and explains it once (RN6–RN8)', async () => {
    // Before an opening (rule T6) a count is skipped but kept, and its key replays it.
    const early = randomUUID();
    const skipped = await count('USD', 7 * USD, early);
    expect(skipped.status).toBe(201);
    const first = await body(skipped);
    expect(first).toMatchObject({
      results: [
        { status: 'skipped', actualUnits: 7 * USD, details: { reason: 'opening_missing' } },
      ],
    });
    const replayed = await count('USD', 7 * USD, early);
    expect(replayed.status).toBe(200);
    expect((await body(replayed)).id).toBe(first.id);
    const { movement } = await test.db.transaction((tx) =>
      recordMovement(
        tx,
        {
          idempotencyKey: randomUUID(),
          kind: 'transfer',
          from: 'outside_usd',
          to: 'sham_cash_usd',
          sentUnits: 40 * USD,
          receivedUnits: 40 * USD,
          outsideCategory: 'owner',
          openingBalance: true,
          orderId: null,
          externalReference: null,
          reason: 'Opening for the API tests',
        },
        actor(),
      ),
    );
    movements.push(movement.id);
    const books = await placeBooks(test.db, 'sham_cash_usd');

    const key = randomUUID();
    const response = await count('USD', books, key);
    expect(response.status).toBe(201);
    const ok = await body(response);
    expect(ok).toMatchObject({
      trigger: 'count',
      status: 'finished',
      mismatchCount: 0,
      results: [
        { check: 'sham_cash_count', subject: 'sham_cash_usd', status: 'ok', actualUnits: books },
      ],
    });
    const replay = await count('USD', books, key);
    expect(replay.status).toBe(200);
    expect((await body(replay)).id).toBe(ok.id);
    expect(await body(await count('USD', books + 10_000, key))).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await body(await count('USD', 1))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    const short = await body(await count('USD', books - 5 * USD));
    expect(short).toMatchObject({ mismatchCount: 1 });
    const result = (short.results as { id: string; status: string }[])[0];
    expect(result?.status).toBe('mismatch');
    // Rule NT1: a count alerts as any run does, once, with the difference.
    const [alert] = await test.db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `reconciliation:${short.id}`));
    expect(alert).toMatchObject({
      kind: 'reconciliation_alert',
      params: {
        trigger: 'count',
        failed: false,
        urgent: false,
        lines: [
          {
            check: 'sham_cash_count',
            subject: 'sham_cash_usd',
            status: 'mismatch',
            differenceUnits: -5 * USD,
          },
        ],
      },
    });
    const overview = await body(
      await client.get('/api/admin/reconciliation', { cookie: admin.cookie }),
    );
    // The newest finished run of any trigger: this count (S13 screens: no "no run yet" after it).
    expect(overview.lastRun).toMatchObject({ id: short.id, trigger: 'count' });
    const open = overview.openMismatches as { id: string; firstSeenAt: string }[];
    expect(open.map((item) => item.id)).toContain(result?.id);
    expect(overview.shamCashCounts as { currency: string; countedUnits: number }[]).toContainEqual(
      expect.objectContaining({ currency: 'USD', countedUnits: books - 5 * USD }),
    );

    const explained = await explain(result?.id as string);
    expect(explained.status).toBe(201);
    expect(await body(explained)).toMatchObject({
      id: result?.id,
      explanation: { note: 'Checked with the bank', adminName: expect.any(String) },
    });
    expect((await auditOf(test.db, result?.id as string))[0]).toMatchObject({
      action: 'reconciliation_result.explained',
      reason: 'Checked with the bank',
    });
    expect(await body(await explain(result?.id as string))).toMatchObject({
      status: 409,
      code: 'RESULT_NOT_EXPLAINABLE',
    });
    const after = await body(
      await client.get('/api/admin/reconciliation', { cookie: admin.cookie }),
    );
    expect((after.openMismatches as { id: string }[]).map((item) => item.id)).not.toContain(
      result?.id,
    );

    // An older result, or one that is not a mismatch, cannot be explained.
    const again = await body(await count('USD', books - 5 * USD));
    expect(await body(await explain(result?.id as string))).toMatchObject({ status: 409 });
    expect(
      await body(
        await explain(ok.results ? ((ok.results as { id: string }[])[0]?.id as string) : ''),
      ),
    ).toMatchObject({
      status: 409,
      code: 'RESULT_NOT_EXPLAINABLE',
    });
    // Rule RN7: the lasting difference is open again.
    const reopened = await body(
      await client.get('/api/admin/reconciliation', { cookie: admin.cookie }),
    );
    expect((reopened.openMismatches as { id: string }[]).map((item) => item.id)).toContain(
      (again.results as { id: string }[])[0]?.id,
    );
    // The navigation badge and the dashboard's items (S13 screens) count the same open mismatches.
    const badge = await body(
      await client.get('/api/admin/reconciliation/counts', { cookie: admin.cookie }),
    );
    expect(badge.open).toBe((reopened.openMismatches as unknown[]).length);
    const dashboard = await body(
      await client.get('/api/admin/dashboard', { cookie: admin.cookie }),
    );
    const attention = dashboard.attention as { kind: string; count: number; oldestAt: string }[];
    expect(attention.find((item) => item.kind === 'reconciliation_open')).toMatchObject({
      count: badge.open,
      target: '/reconciliation',
    });
    // A count was entered just now: none is due (rule E5).
    expect(attention.map((item) => item.kind)).not.toContain('sham_cash_count_due');
    const [lastNightly] = await test.db
      .select({ finishedAt: reconciliationRuns.finishedAt })
      .from(reconciliationRuns)
      .where(
        and(eq(reconciliationRuns.trigger, 'schedule'), eq(reconciliationRuns.status, 'finished')),
      )
      .orderBy(desc(reconciliationRuns.finishedAt))
      .limit(1);
    const missing = attention.find((item) => item.kind === 'reconciliation_missing');
    if (
      lastNightly?.finishedAt &&
      Date.now() - lastNightly.finishedAt.getTime() <= RECONCILIATION_MISSING_HOURS * 3_600_000
    ) {
      expect(missing).toBeUndefined();
    } else {
      expect(missing).toMatchObject({
        count: 1,
        oldestAt: lastNightly?.finishedAt?.toISOString() ?? null,
      });
    }
    expect(await body(await explain(randomUUID()))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(await body(await explain(randomUUID(), 'no'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('settings', () => {
  it('changes the settings with re-authentication and an audit entry', async () => {
    const changed = await client.put('/api/admin/reconciliation/settings', {
      cookie: admin.cookie,
      body: { toleranceUsdUnits: 2 * USD, countStaleDays: 10 },
    });
    expect(changed.status).toBe(200);
    expect(
      await body(await client.get('/api/admin/reconciliation/settings', { cookie: admin.cookie })),
    ).toMatchObject({
      toleranceUsdUnits: 2 * USD,
      countStaleDays: 10,
    });
    expect(
      await body(
        await client.put('/api/admin/reconciliation/settings', {
          cookie: admin.cookie,
          body: { toleranceUsdUnits: 101 * USD, countStaleDays: 10 },
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const restored = await client.put('/api/admin/reconciliation/settings', {
      cookie: admin.cookie,
      body: {
        toleranceUsdUnits: settingsBefore.toleranceUsdUnits,
        countStaleDays: settingsBefore.countStaleDays,
      },
    });
    expect(restored.status).toBe(200);
    const [run] = await test.db
      .select({ id: reconciliationRuns.id })
      .from(reconciliationRuns)
      .where(and(eq(reconciliationRuns.trigger, 'count'), eq(reconciliationRuns.adminId, admin.id)))
      .limit(1);
    expect(run).toBeDefined();
  });

  it('refuses a change without a recent re-authentication', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    expect(
      await body(
        await client.put('/api/admin/reconciliation/settings', {
          cookie: fresh.cookie,
          body: { toleranceUsdUnits: USD, countStaleDays: 7 },
        }),
      ),
    ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    admin = fresh;
  });
});
