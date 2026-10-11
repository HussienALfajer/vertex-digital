import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';

/*
 * Store content (S14): seeds, checks, the one-enabled announcement, the append-only versions and
 * publications, the grants and the customers' accepted versions. Writes run in rolled-back
 * transactions, so no test leaves a row behind.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(async () => {
  await connection.close();
  await owner.close();
});

async function rolledBack(
  work: (client: pg.PoolClient) => Promise<void>,
  database: typeof connection = connection,
) {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Runs `sql` under a savepoint and returns the constraint or message it failed with, or null. */
async function violation(client: pg.PoolClient, sql: string, values: unknown[] = []) {
  await client.query('savepoint attempt');
  try {
    await client.query(sql, values);
    await client.query('release savepoint attempt');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
}

async function version(client: pg.PoolClient, page: string, number = 900_000) {
  const id = newId();
  await client.query(
    `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
     values ($1, $2, $3, 'عنوان', 'نص', 1, $4)`,
    [id, page, number, newId()],
  );
  return id;
}

async function file(client: pg.PoolClient) {
  const id = newId();
  await client.query(
    `insert into stored_files (id, kind, storage_key, content_type, byte_size, width, height)
     values ($1, 'catalog_image', $2, 'image/webp', 10, 1600, 800)`,
    [id, `catalog_image/${id.slice(-2)}/${id}.webp`],
  );
  return id;
}

describe('seeds', () => {
  // The titles are seeded by migration 0048; drafts are edited in place afterwards, so only the
  // four rows are checked here.
  it('hold the four drafts and the settings row', async () => {
    const drafts = await connection.pool.query(
      `select page from content_page_drafts order by page`,
    );
    expect(drafts.rows.map((row) => row.page)).toEqual(['terms', 'privacy', 'refund', 'about']);
    const settings = await connection.pool.query(
      `select id, live_activity_enabled from content_settings`,
    );
    expect(settings.rows).toMatchObject([{ id: 1 }]);
  });

  it('index the store-wide activity on real deliveries', async () => {
    const { rows } = await connection.pool.query(
      `select indexdef from pg_indexes where indexname = 'orders_activity_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/delivered_at DESC.*status = 'delivered'.*NOT is_test/);
  });
});

describe('checks', () => {
  it('bound drafts, versions, FAQ rows and settings', async () => {
    await rolledBack(async (client) => {
      expect(
        await violation(client, `update content_page_drafts set title = 'ا' where page = 'terms'`),
      ).toBe('content_page_drafts_title_check');
      expect(
        await violation(
          client,
          `update content_page_drafts set body = repeat('ا', 30001) where page = 'terms'`,
        ),
      ).toBe('content_page_drafts_body_check');
      expect(
        await violation(
          client,
          `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
           values ($1, 'terms', 1, 'عنوان', '', 0, $2)`,
          [newId(), newId()],
        ),
      ).toBe('content_page_versions_body_check');
      expect(await violation(client, `update content_settings set id = 2`)).toBe(
        'content_settings_one_row_check',
      );
      const section = newId();
      await client.query(`insert into faq_sections (id, title, position) values ($1, 'قسم', 1)`, [
        section,
      ]);
      expect(
        await violation(
          client,
          `insert into faq_items (id, section_id, question, answer, position) values ($1, $2, 'سؤال', 'جواب', 1)`,
          [newId(), section],
        ),
      ).toBe('faq_items_question_check');
      expect(
        await violation(
          client,
          `insert into faq_publications (id, faq_revision, sections, admin_id) values ($1, 1, '{}', $2)`,
          [newId(), newId()],
        ),
      ).toBe('faq_publications_sections_check');
    });
  });

  it('refuse a page version twice', async () => {
    await rolledBack(async (client) => {
      await version(client, 'refund', 900_001);
      expect(
        await violation(
          client,
          `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
           values ($1, 'refund', 900001, 'عنوان', 'نص', 1, $2)`,
          [newId(), newId()],
        ),
      ).toBe('content_page_versions_page_version_idx');
    });
  });

  it('keep link paths internal, schedules ordered and archived rows disabled', async () => {
    await rolledBack(async (client) => {
      const image = await file(client);
      const banner = (values: string) =>
        violation(
          client,
          `insert into banners (id, image_file_id, alt_text, position, link_path, starts_at, ends_at, enabled, archived_at)
           values ($1, $2, 'بانر', 1, ${values})`,
          [newId(), image],
        );
      expect(await banner(`'/games/pubg#top', null, null, true, null`)).toBeNull();
      for (const path of [
        'https://x.y',
        '//x.y',
        '/a/../b',
        '/a?b=1',
        'faq',
        `/${'a'.repeat(200)}`,
      ]) {
        expect(await banner(`'${path}', null, null, false, null`)).toBe('banners_link_path_check');
      }
      expect(await banner(`null, now(), now() - interval '1 hour', false, null`)).toBe(
        'banners_schedule_check',
      );
      expect(await banner(`null, null, null, true, now()`)).toBe('banners_archived_check');
      const announcement = (values: string) =>
        violation(
          client,
          `insert into announcements (id, text, link_path, starts_at, ends_at, enabled, archived_at)
           values ($1, 'إعلان مهم', ${values})`,
          [newId()],
        );
      expect(await announcement(`'https://x.y', null, null, false, null`)).toBe(
        'announcements_link_path_check',
      );
      expect(await announcement(`null, now(), now(), false, null`)).toBe(
        'announcements_schedule_check',
      );
      expect(await announcement(`null, null, null, true, now()`)).toBe(
        'announcements_archived_check',
      );
      expect(
        await violation(client, `insert into announcements (id, text) values ($1, 'قصير')`, [
          newId(),
        ]),
      ).toBe('announcements_text_check');
    });
  });

  it('allow one enabled announcement (AN2)', async () => {
    await rolledBack(async (client) => {
      await client.query(`update announcements set enabled = false where enabled`);
      const insert = (enabled: boolean, archived: boolean) =>
        violation(
          client,
          `insert into announcements (id, text, enabled, archived_at) values ($1, 'إعلان مهم', $2, $3)`,
          [newId(), enabled, archived ? new Date() : null],
        );
      expect(await insert(true, false)).toBeNull();
      expect(await insert(false, false)).toBeNull();
      expect(await insert(false, true)).toBeNull();
      expect(await insert(true, false)).toBe('announcements_one_enabled_idx');
    });
  });
});

describe('append-only and grants', () => {
  it('keep versions and publications for the app role and the owner', async () => {
    for (const database of [connection, owner]) {
      await rolledBack(async (client) => {
        const id = await version(client, 'about', 900_002);
        const publication = newId();
        await client.query(
          `insert into faq_publications (id, faq_revision, sections, admin_id) values ($1, 1, '[]', $2)`,
          [publication, newId()],
        );
        for (const [statement, value] of [
          ['update content_page_versions set title = title where id = $1', id],
          ['delete from content_page_versions where id = $1', id],
          ['update faq_publications set faq_revision = 2 where id = $1', publication],
          ['delete from faq_publications where id = $1', publication],
        ] as const) {
          expect(await violation(client, statement, [value])).toMatch(
            /permission denied|append-only/,
          );
        }
      }, database);
    }
  });

  it('let the app role delete no content row', async () => {
    for (const table of [
      'content_page_drafts',
      'content_settings',
      'faq_sections',
      'faq_items',
      'banners',
      'announcements',
    ]) {
      await expect(connection.pool.query(`delete from ${table} where false`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe('customers accepted versions (TA2)', () => {
  it('take versions of their own page, once', async () => {
    await rolledBack(async (client) => {
      const terms = await version(client, 'terms', 900_003);
      const privacy = await version(client, 'privacy', 900_003);
      const insert = (termsId: string | null, privacyId: string | null) => {
        const id = newId();
        return violation(
          client,
          `insert into customers (id, name, email, phone, terms_version_id, privacy_version_id)
           values ($1, 'Test', $2, '+963900000000', $3, $4)`,
          [id, `${id}@example.com`, termsId, privacyId],
        ).then((failure) => ({ id, failure }));
      };
      expect((await insert(privacy, null)).failure).toMatch(/not a terms version/);
      expect((await insert(null, terms)).failure).toMatch(/not a privacy version/);
      expect((await insert(null, null)).failure).toBeNull();
      const { id, failure } = await insert(terms, privacy);
      expect(failure).toBeNull();
      expect(
        await violation(client, `update customers set terms_version_id = null where id = $1`, [id]),
      ).toMatch(/never change/);
      expect(
        await violation(client, `update customers set name = 'Other' where id = $1`, [id]),
      ).toBeNull();
    });
  });
});
