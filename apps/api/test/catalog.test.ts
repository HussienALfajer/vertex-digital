import { randomBytes } from 'node:crypto';
import { CATALOG_IMAGE_MAX_BYTES } from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  newId,
  storedFiles,
} from '@vertex-digital/db';
import { asc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, removeAccounts, seedCustomer } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The catalog (S06, F08) over HTTP against the test database: every route, rules CT1–CT10, the
 * public image route and the concurrency the spec names. Catalog rows of this file are removed in
 * `afterAll`; stored files are append-only and stay.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let customerCookie: string;
const seeded: string[] = [];
const categoryIds: string[] = [];
const gameIds: string[] = [];
const run = randomBytes(4).toString('hex');
let counter = 0;
const unique = (label: string) => `${label}-${run}-${++counter}`;

async function image(format: 'png' | 'jpeg' | 'webp' = 'png', size = 32): Promise<Buffer> {
  const pipeline = sharp(randomBytes(size * size * 3), {
    raw: { width: size, height: size, channels: 3 },
  });
  return format === 'png'
    ? pipeline.png().toBuffer()
    : format === 'jpeg'
      ? pipeline
          .jpeg()
          .withExif({ IFD0: { Copyright: 'secret' } })
          .toBuffer()
      : pipeline.webp().toBuffer();
}

const form = (file: Buffer, name = 'cover.png') => {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(file)]), name);
  return data;
};

const get = (path: string) => client.get(`/api/admin/catalog${path}`, { cookie: admin.cookie });
const post = (path: string, payload?: unknown) =>
  client.post(`/api/admin/catalog${path}`, { cookie: admin.cookie, body: payload });
const patch = (path: string, payload: unknown) =>
  client.patch(`/api/admin/catalog${path}`, { cookie: admin.cookie, body: payload });
const put = (path: string, payload: unknown) =>
  client.put(`/api/admin/catalog${path}`, { cookie: admin.cookie, body: payload });

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

async function upload(): Promise<string> {
  const response = await client.post('/api/admin/catalog/images', {
    cookie: admin.cookie,
    form: form(await image()),
  });
  return (await json<{ id: string }>(response, 201)).id;
}

async function newCategory(): Promise<{ id: string; slug: string; nameAr: string }> {
  const slug = unique('cat');
  const category = await json<{ id: string; slug: string; nameAr: string }>(
    await post('/categories', { slug, nameAr: `فئة ${slug}` }),
    201,
  );
  categoryIds.push(category.id);
  return category;
}

interface GameBody {
  id: string;
  status: string;
  categoryId: string;
  sortOrder: number;
  fields: { id: string; key: string; required: boolean; archivedAt: string | null }[];
  products: { id: string; nameAr: string; availability: string; archivedAt: string | null }[];
}

async function newGame(categoryId: string, extra: Record<string, unknown> = {}): Promise<GameBody> {
  const slug = unique('game');
  const game = await json<GameBody>(
    await post('/games', {
      categoryId,
      slug,
      nameAr: `لعبة ${slug}`,
      nameEn: `Game ${slug}`,
      ...extra,
    }),
    201,
  );
  gameIds.push(game.id);
  return game;
}

const playerId = {
  key: 'player_id',
  labelAr: 'معرّف اللاعب',
  type: 'digits',
  required: true,
  minLength: 5,
  maxLength: 15,
};

/** An active game: cover, a required field and a direct product. */
async function activeGame(categoryId: string): Promise<GameBody> {
  const game = await newGame(categoryId, { coverFileId: await upload() });
  await json(await post(`/games/${game.id}/fields`, playerId), 201);
  await json(await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '60 UC' }), 201);
  return json<GameBody>(await patch(`/games/${game.id}`, { status: 'active' }), 200);
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  customerCookie = await client.signInCustomer(customer.email);
});

afterAll(async () => {
  const games = await test.db
    .select({ id: catalogGames.id })
    .from(catalogGames)
    .where(inArray(catalogGames.categoryId, categoryIds.length ? categoryIds : [run]));
  const allGames = [...new Set([...gameIds, ...games.map((game) => game.id)])];
  if (allGames.length) {
    await test.db.delete(catalogProducts).where(inArray(catalogProducts.gameId, allGames));
    await test.db.delete(catalogInputFields).where(inArray(catalogInputFields.gameId, allGames));
    await test.db.delete(catalogGames).where(inArray(catalogGames.id, allGames));
  }
  if (categoryIds.length) {
    await test.db.delete(catalogCategories).where(inArray(catalogCategories.id, categoryIds));
  }
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  const routes: [string, string][] = [
    ['GET', '/api/admin/catalog/categories'],
    ['POST', '/api/admin/catalog/categories'],
    ['PUT', '/api/admin/catalog/categories/order'],
    ['GET', '/api/admin/catalog/games'],
    ['POST', '/api/admin/catalog/games'],
    ['POST', '/api/admin/catalog/images'],
    ['PATCH', `/api/admin/catalog/products/${run.padEnd(8, '0')}-0000-7000-8000-000000000000`],
  ];

  it('answers 401 without a session and to a customer session', async () => {
    for (const [method, path] of routes) {
      for (const cookie of [undefined, customerCookie]) {
        const response = await fetch(`${test.url}${path}`, {
          method,
          headers: {
            origin: 'http://127.0.0.1:5173',
            ...(cookie && { cookie }),
            'content-type': 'application/json',
          },
          body: method === 'GET' ? undefined : '{}',
        });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('never caches admin answers', async () => {
    const response = await get('/categories');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('images (rule CT10)', () => {
  it('re-encodes an upload to WebP without metadata, served publicly and immutable', async () => {
    const jpeg = await image('jpeg', 2000);
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const uploaded = await json<{ id: string; url: string; width: number; height: number }>(
      await client.post('/api/admin/catalog/images', {
        cookie: admin.cookie,
        form: form(jpeg, 'c.jpg'),
      }),
      201,
    );
    expect(uploaded).toMatchObject({
      url: `/api/catalog/images/${uploaded.id}`,
      width: 1600,
      height: 1600,
    });
    const served = await fetch(`${test.url}${uploaded.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    const metadata = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 1600 });
    expect(metadata.exif).toBeUndefined();
    // Not audited by itself.
    expect(await auditOf(test.db, uploaded.id)).toEqual([]);
  });

  it('refuses anything but an image within the limits', async () => {
    const pdf = await client.post('/api/admin/catalog/images', {
      cookie: admin.cookie,
      form: form(Buffer.from('%PDF-1.7\n1 0 obj\n'), 'c.pdf'),
    });
    expect(await body(pdf)).toMatchObject({ status: 400, code: 'IMAGE_INVALID' });
    const large = await client.post('/api/admin/catalog/images', {
      cookie: admin.cookie,
      form: form(Buffer.alloc(CATALOG_IMAGE_MAX_BYTES + 1), 'c.png'),
    });
    expect(await body(large)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    // 26 megapixels of a single color: small on disk, above the pixel limit.
    const bomb = await sharp({
      create: { width: 5200, height: 5000, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const refused = await client.post('/api/admin/catalog/images', {
      cookie: admin.cookie,
      form: form(bomb),
    });
    expect(await body(refused)).toMatchObject({ status: 400, code: 'IMAGE_INVALID' });
  });

  it('serves catalog images only: other files and unknown ids are NOT_FOUND', async () => {
    const [receipt] = await test.db
      .select({ id: storedFiles.id })
      .from(storedFiles)
      .where(eq(storedFiles.kind, 'sham_cash_qr'))
      .limit(1);
    for (const id of [receipt?.id, '0199a000-0000-7000-8000-000000000001', 'not-a-uuid']) {
      if (!id) continue;
      expect(await body(await fetch(`${test.url}/api/catalog/images/${id}`))).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    }
  });
});

describe('categories (rules CT1, CT2, CT5)', () => {
  it('lists the seeded categories with their game counts', async () => {
    const categories = await json<{ slug: string; gameCount: number }[]>(
      await get('/categories'),
      200,
    );
    expect(categories.map((category) => category.slug)).toEqual(
      expect.arrayContaining(['games', 'apps', 'gift-cards']),
    );
  });

  it('creates, renames and audits; slugs and live names are taken', async () => {
    const category = await newCategory();
    expect(await auditOf(test.db, category.id)).toMatchObject([
      {
        action: 'catalog_category.created',
        details: { slug: category.slug, nameAr: category.nameAr },
      },
    ]);
    expect(
      await body(await post('/categories', { slug: category.slug, nameAr: unique('x') })),
    ).toMatchObject({
      status: 409,
      code: 'SLUG_TAKEN',
    });
    expect(
      await body(await post('/categories', { slug: unique('s'), nameAr: category.nameAr })),
    ).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
    const renamed = await json(
      await patch(`/categories/${category.id}`, { nameAr: `${category.nameAr} 2` }),
      200,
    );
    expect(renamed).toMatchObject({ nameAr: `${category.nameAr} 2` });
    const entries = await auditOf(test.db, category.id);
    expect(entries.at(-1)).toMatchObject({
      action: 'catalog_category.updated',
      details: { before: { nameAr: category.nameAr }, after: { nameAr: `${category.nameAr} 2` } },
    });
    expect(
      await body(await patch('/categories/0199a000-0000-7000-8000-000000000001', { nameAr: 'x' })),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('refuses to archive a category with games, then archives, hides and restores it', async () => {
    const category = await newCategory();
    const game = await newGame(category.id);
    const refused = await body(await post(`/categories/${category.id}/archive`));
    expect(refused).toMatchObject({
      status: 409,
      code: 'CATALOG_NOT_EMPTY',
      details: { games: [{ id: game.id }] },
    });
    await json(await post(`/games/${game.id}/archive`), 200);
    const archived = await json<{ archivedAt: string | null }>(
      await post(`/categories/${category.id}/archive`),
      200,
    );
    expect(archived.archivedAt).not.toBeNull();
    const live = await json<{ id: string }[]>(await get('/categories'), 200);
    expect(live.map((row) => row.id)).not.toContain(category.id);
    const archivedList = await json<{ id: string }[]>(await get('/categories?archived=true'), 200);
    expect(archivedList.map((row) => row.id)).toContain(category.id);
    // A game cannot be restored or created under an archived category (rule CT1, edge case 4).
    expect(await body(await post(`/games/${game.id}/restore`))).toMatchObject({
      status: 409,
      code: 'PARENT_ARCHIVED',
    });
    expect(
      await body(
        await post('/games', {
          categoryId: category.id,
          slug: unique('g'),
          nameAr: unique('ن'),
          nameEn: 'X',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'PARENT_ARCHIVED' });
    const other = await newGame((await newCategory()).id);
    expect(
      await body(await patch(`/games/${other.id}`, { categoryId: category.id })),
    ).toMatchObject({
      status: 409,
      code: 'PARENT_ARCHIVED',
    });
    // A slug is never reused, even archived.
    expect(
      await body(await post('/categories', { slug: category.slug, nameAr: unique('y') })),
    ).toMatchObject({
      status: 409,
      code: 'SLUG_TAKEN',
    });
    const restored = await json<{ archivedAt: string | null }>(
      await post(`/categories/${category.id}/restore`),
      200,
    );
    expect(restored.archivedAt).toBeNull();
    expect((await auditOf(test.db, category.id)).map((entry) => entry.action)).toEqual([
      'catalog_category.created',
      'catalog_category.archived',
      'catalog_category.restored',
    ]);
  });

  it('refuses a restore when a live category took the name', async () => {
    const category = await newCategory();
    await json(await post(`/categories/${category.id}/archive`), 200);
    const twin = await json<{ id: string }>(
      await post('/categories', { slug: unique('t'), nameAr: category.nameAr }),
      201,
    );
    categoryIds.push(twin.id);
    expect(await body(await post(`/categories/${category.id}/restore`))).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
  });

  it('reorders the full list only, and audits once', async () => {
    const before = await json<{ id: string }[]>(await get('/categories'), 200);
    const ids = before.map((row) => row.id);
    const reversed = [...ids].reverse();
    const after = await json<{ id: string; sortOrder: number }[]>(
      await put('/categories/order', { ids: reversed }),
      200,
    );
    expect(after.map((row) => row.id)).toEqual(reversed);
    expect(after.map((row) => row.sortOrder)).toEqual(reversed.map((_, index) => index + 1));
    expect(await body(await put('/categories/order', { ids: reversed.slice(1) }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await json(await put('/categories/order', { ids }), 200);
  });
});

describe('games (rules CT1, CT3, CT4, CT6)', () => {
  it('creates a paused game last in its category, with its images, and audits it', async () => {
    const category = await newCategory();
    const first = await newGame(category.id);
    const cover = await upload();
    const second = await newGame(category.id, { coverFileId: cover, accentColor: '#f2a900' });
    expect(first).toMatchObject({ status: 'paused', sortOrder: 1 });
    expect(second).toMatchObject({
      status: 'paused',
      sortOrder: 2,
      accentColor: '#F2A900',
      cover: { id: cover, url: `/api/catalog/images/${cover}` },
      fields: [],
      products: [],
      categoryArchived: false,
    });
    expect(await auditOf(test.db, second.id)).toMatchObject([
      { action: 'catalog_game.created', details: { coverFileId: cover, status: 'paused' } },
    ]);
  });

  it('refuses a missing category or image, a low-contrast accent, a taken slug or name', async () => {
    const category = await newCategory();
    const values = () => ({
      categoryId: category.id,
      slug: unique('g'),
      nameAr: unique('ل'),
      nameEn: 'Game',
    });
    expect(
      await body(
        await post('/games', { ...values(), categoryId: '0199a000-0000-7000-8000-000000000001' }),
      ),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(
      await body(
        await post('/games', { ...values(), coverFileId: '0199a000-0000-7000-8000-000000000001' }),
      ),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    const low = await body(await post('/games', { ...values(), accentColor: '#102020' }));
    expect(low).toMatchObject({ status: 400, code: 'ACCENT_CONTRAST_TOO_LOW' });
    expect((low.details as { ratio: number }).ratio).toBeLessThan(3);
    const game = await newGame(category.id);
    const detail = await json<{ slug: string; nameAr: string }>(
      await get(`/games/${game.id}`),
      200,
    );
    expect(await body(await post('/games', { ...values(), slug: detail.slug }))).toMatchObject({
      status: 409,
      code: 'SLUG_TAKEN',
    });
    expect(await body(await post('/games', { ...values(), nameAr: detail.nameAr }))).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
    expect(await body(await get('/games/0199a000-0000-7000-8000-000000000001'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('activates only a complete game (rule CT3)', async () => {
    const category = await newCategory();
    const game = await newGame(category.id);
    expect(await body(await patch(`/games/${game.id}`, { status: 'active' }))).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
      details: { missing: ['cover'] },
    });
    await json(
      await patch(`/games/${game.id}`, {
        coverFileId: await upload(),
        idGuideFileId: await upload(),
      }),
      200,
    );
    await json(
      await post(`/games/${game.id}/products`, {
        kind: 'direct',
        nameAr: '60 UC',
        gameAmount: 60,
        officialPriceUsdUnits: 990_000,
      }),
      201,
    );
    expect(await body(await patch(`/games/${game.id}`, { status: 'active' }))).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
      details: { missing: ['input_fields'] },
    });
    await json(await post(`/games/${game.id}/fields`, playerId), 201);
    const active = await json<GameBody>(
      await patch(`/games/${game.id}`, { status: 'active' }),
      200,
    );
    expect(active.status).toBe('active');
    expect((await auditOf(test.db, game.id)).at(-1)).toMatchObject({
      action: 'catalog_game.updated',
      details: { before: { status: 'paused' }, after: { status: 'active' } },
    });
    // Removing the cover of an active game is refused too.
    expect(await body(await patch(`/games/${game.id}`, { coverFileId: null }))).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
    });
    // A code-only game needs no field.
    const codes = await newGame(category.id, { coverFileId: await upload() });
    await json(
      await post(`/games/${codes.id}/products`, { kind: 'code', nameAr: 'بطاقة 10$' }),
      201,
    );
    expect(
      (await json<GameBody>(await patch(`/games/${codes.id}`, { status: 'active' }), 200)).status,
    ).toBe('active');
  });

  it('moves a game to the end of another category and never changes its slug', async () => {
    const from = await newCategory();
    const to = await newCategory();
    await newGame(to.id);
    const game = await newGame(from.id);
    const moved = await json<GameBody & { slug: string }>(
      await patch(`/games/${game.id}`, { categoryId: to.id, slug: 'other-slug' }),
      200,
    );
    expect(moved).toMatchObject({ categoryId: to.id, sortOrder: 2 });
    expect(moved.slug).not.toBe('other-slug');
  });

  it('lists games by page with filters, and reorders a category', async () => {
    const category = await newCategory();
    const a = await newGame(category.id);
    const b = await newGame(category.id);
    const c = await newGame(category.id);
    const page = await json<{
      items: { id: string }[];
      total: number;
      page: number;
      pageSize: number;
    }>(await get(`/games?categoryId=${category.id}&pageSize=2`), 200);
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page.items.map((game) => game.id)).toEqual([a.id, b.id]);
    const search = await json<{ items: { id: string }[] }>(
      await get(`/games?q=${encodeURIComponent(`Game game-${run}`)}&categoryId=${category.id}`),
      200,
    );
    expect(search.items).toHaveLength(3);
    const ordered = await json<{ id: string }[]>(
      await put(`/categories/${category.id}/games/order`, { ids: [c.id, a.id, b.id] }),
      200,
    );
    expect(ordered.map((game) => game.id)).toEqual([c.id, a.id, b.id]);
    expect(
      await body(await put(`/categories/${category.id}/games/order`, { ids: [c.id, a.id] })),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await json(await post(`/games/${b.id}/archive`), 200);
    const archived = await json<{ items: { id: string }[] }>(
      await get(`/games?categoryId=${category.id}&archived=true`),
      200,
    );
    expect(archived.items.map((game) => game.id)).toEqual([b.id]);
    const paused = await json<{ total: number }>(
      await get(`/games?categoryId=${category.id}&status=active`),
      200,
    );
    expect(paused.total).toBe(0);
    expect((await auditOf(test.db, category.id)).map((entry) => entry.action)).toContain(
      'catalog_game.reordered',
    );
  });

  it('restores an archived game last, refused when a live game took its name', async () => {
    const category = await newCategory();
    const game = await newGame(category.id);
    const detail = await json<{ nameAr: string }>(await post(`/games/${game.id}/archive`), 200);
    await newGame(category.id);
    const restored = await json<GameBody>(await post(`/games/${game.id}/restore`), 200);
    expect(restored.sortOrder).toBe(2);
    await json(await post(`/games/${game.id}/archive`), 200);
    await newGame(category.id, { nameAr: detail.nameAr });
    expect(await body(await post(`/games/${game.id}/restore`))).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
  });
});

describe('input fields (rules CT3, CT7)', () => {
  it('creates fields by type, refuses a taken key, wrong bounds and the 11th field', async () => {
    const game = await newGame((await newCategory()).id);
    const field = await json<{ id: string; options: null }>(
      await post(`/games/${game.id}/fields`, playerId),
      201,
    );
    expect(await auditOf(test.db, field.id)).toMatchObject([
      {
        action: 'catalog_input_field.created',
        details: { identifier: 'player_id', type: 'digits' },
      },
    ]);
    expect(
      await body(await post(`/games/${game.id}/fields`, { ...playerId, type: 'text' })),
    ).toMatchObject({
      status: 409,
      code: 'FIELD_KEY_TAKEN',
    });
    expect(
      await body(
        await post(`/games/${game.id}/fields`, { ...playerId, key: 'zone_id', maxLength: 40 }),
      ),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    for (let index = 2; index <= 10; index++) {
      await json(
        await post(`/games/${game.id}/fields`, {
          key: `f${index}`,
          labelAr: `حقل ${index}`,
          type: 'phone',
          required: false,
        }),
        201,
      );
    }
    expect(
      await body(
        await post(`/games/${game.id}/fields`, {
          key: 'f11',
          labelAr: 'حقل',
          type: 'phone',
          required: false,
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'CATALOG_LIMIT_REACHED',
    });
    // An archived key stays taken; restoring beyond 10 is refused (edge case 10).
    const last = (await json<GameBody>(await get(`/games/${game.id}`), 200)).fields.at(-1) as {
      id: string;
      key: string;
    };
    await json(await post(`/fields/${last.id}/archive`), 200);
    expect(
      await body(
        await post(`/games/${game.id}/fields`, {
          key: last.key,
          labelAr: 'حقل',
          type: 'phone',
          required: false,
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'FIELD_KEY_TAKEN',
    });
    await json(
      await post(`/games/${game.id}/fields`, {
        key: 'f12',
        labelAr: 'حقل',
        type: 'phone',
        required: false,
      }),
      201,
    );
    expect(await body(await post(`/fields/${last.id}/restore`))).toMatchObject({
      status: 409,
      code: 'CATALOG_LIMIT_REACHED',
    });
  });

  it('updates everything but the key and type, checked against the stored type', async () => {
    const game = await newGame((await newCategory()).id);
    const select = await json<{ id: string }>(
      await post(`/games/${game.id}/fields`, {
        key: 'server',
        labelAr: 'السيرفر',
        type: 'select',
        required: true,
        options: [
          { value: 'eu', labelAr: 'أوروبا' },
          { value: 'asia', labelAr: 'آسيا' },
        ],
      }),
      201,
    );
    const updated = await json(
      await patch(`/fields/${select.id}`, { labelAr: 'الخادم', key: 'other', type: 'text' }),
      200,
    );
    expect(updated).toMatchObject({ labelAr: 'الخادم', key: 'server', type: 'select' });
    expect(await body(await patch(`/fields/${select.id}`, { options: null }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await body(await patch(`/fields/${select.id}`, { minLength: 3 }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect((await auditOf(test.db, select.id)).at(-1)).toMatchObject({
      action: 'catalog_input_field.updated',
      details: { before: { labelAr: 'السيرفر' }, after: { labelAr: 'الخادم' } },
    });
  });

  it('keeps an active game complete: the last required field is not archived or made optional', async () => {
    const game = await activeGame((await newCategory()).id);
    const field = game.fields[0] as { id: string };
    expect(await body(await post(`/fields/${field.id}/archive`))).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
      details: { missing: ['input_fields'] },
    });
    expect(await body(await patch(`/fields/${field.id}`, { required: false }))).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
    });
    // With a second required field, the first can go.
    await json(
      await post(`/games/${game.id}/fields`, {
        key: 'zone_id',
        labelAr: 'المنطقة',
        type: 'digits',
        required: true,
      }),
      201,
    );
    await json(await post(`/fields/${field.id}/archive`), 200);
  });

  it('reorders fields; a stale list is refused', async () => {
    const game = await newGame((await newCategory()).id);
    const a = await json<{ id: string }>(await post(`/games/${game.id}/fields`, playerId), 201);
    const b = await json<{ id: string }>(
      await post(`/games/${game.id}/fields`, { ...playerId, key: 'zone_id' }),
      201,
    );
    const ordered = await json<{ id: string }[]>(
      await put(`/games/${game.id}/fields/order`, { ids: [b.id, a.id] }),
      200,
    );
    expect(ordered.map((field) => field.id)).toEqual([b.id, a.id]);
    expect(await body(await put(`/games/${game.id}/fields/order`, { ids: [b.id] }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('products (rules CT3, CT8, CT9)', () => {
  it('creates by kind with its defaults, out of stock until S07, and audits', async () => {
    const game = await newGame((await newCategory()).id);
    const direct = await json<Record<string, unknown>>(
      await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '60 UC', gameAmount: 60 }),
      201,
    );
    expect(direct).toMatchObject({ maxQuantity: 1, availability: 'paused', regionAr: null });
    const code = await json<Record<string, unknown>>(
      await post(`/games/${game.id}/products`, {
        kind: 'code',
        nameAr: 'بطاقة 10$',
        regionAr: 'الولايات المتحدة',
        redemptionAr: 'افتح المتجر',
      }),
      201,
    );
    expect(code).toMatchObject({ maxQuantity: 10, regionAr: 'الولايات المتحدة' });
    expect(await auditOf(test.db, code.id as string)).toMatchObject([
      { action: 'catalog_product.created', details: { kind: 'code', maxQuantity: 10 } },
    ]);
    expect(
      await body(await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '60 UC' })),
    ).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
    const active = await activeGame((await newCategory()).id);
    expect(active.products[0]?.availability).toBe('out_of_stock');
  });

  it('updates everything but the kind; code text is refused on a direct product', async () => {
    const game = await newGame((await newCategory()).id);
    const product = await json<{ id: string }>(
      await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '60 UC' }),
      201,
    );
    const updated = await json(
      await patch(`/products/${product.id}`, {
        maxQuantity: 5,
        officialPriceUsdUnits: 990_000,
        status: 'paused',
      }),
      200,
    );
    expect(updated).toMatchObject({
      maxQuantity: 5,
      officialPriceUsdUnits: 990_000,
      status: 'paused',
      kind: 'direct',
    });
    expect(await body(await patch(`/products/${product.id}`, { regionAr: 'US' }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(
      await body(await patch(`/products/${product.id}`, { officialPriceUsdUnits: 990_001 })),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect((await auditOf(test.db, product.id)).at(-1)).toMatchObject({
      action: 'catalog_product.updated',
      details: {
        before: { maxQuantity: 1, status: 'active' },
        after: { maxQuantity: 5, status: 'paused' },
      },
    });
    expect(
      await body(await patch('/products/0199a000-0000-7000-8000-000000000001', { maxQuantity: 2 })),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('refuses a direct product in an active game without a required field (rule CT3)', async () => {
    const category = await newCategory();
    const game = await newGame(category.id, { coverFileId: await upload() });
    await json(await post(`/games/${game.id}/products`, { kind: 'code', nameAr: 'بطاقة' }), 201);
    await json(await patch(`/games/${game.id}`, { status: 'active' }), 200);
    expect(
      await body(await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '60 UC' })),
    ).toMatchObject({
      status: 409,
      code: 'CATALOG_INCOMPLETE',
    });
  });

  it('archives, restores and reorders; restore under an archived game is refused', async () => {
    const game = await newGame((await newCategory()).id);
    const a = await json<{ id: string }>(
      await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '325 UC' }),
      201,
    );
    const b = await json<{ id: string }>(
      await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '660 UC' }),
      201,
    );
    const ordered = await json<{ id: string }[]>(
      await put(`/games/${game.id}/products/order`, { ids: [b.id, a.id] }),
      200,
    );
    expect(ordered.map((product) => product.id)).toEqual([b.id, a.id]);
    const archived = await json<{ availability: string }>(
      await post(`/products/${a.id}/archive`),
      200,
    );
    expect(archived.availability).toBe('hidden');
    const restored = await json<{ archivedAt: string | null; sortOrder: number }>(
      await post(`/products/${a.id}/restore`),
      200,
    );
    expect(restored).toMatchObject({ archivedAt: null, sortOrder: 2 });
    await json(await post(`/products/${a.id}/archive`), 200);
    await json(await post(`/games/${game.id}/archive`), 200);
    expect(await body(await post(`/products/${a.id}/restore`))).toMatchObject({
      status: 409,
      code: 'PARENT_ARCHIVED',
    });
    expect(
      await body(await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: 'x' })),
    ).toMatchObject({
      status: 409,
      code: 'PARENT_ARCHIVED',
    });
    const detail = await json<GameBody>(await get(`/games/${game.id}`), 200);
    expect(detail.products.map((product) => product.availability)).toEqual(['hidden', 'hidden']);
  });

  it('refuses the 101st product (rule CT1)', async () => {
    const game = await newGame((await newCategory()).id);
    await test.db.insert(catalogProducts).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: newId(),
        gameId: game.id,
        kind: 'code' as const,
        nameAr: `باقة ${index}`,
        maxQuantity: 10,
        sortOrder: index + 1,
      })),
    );
    expect(
      await body(await post(`/games/${game.id}/products`, { kind: 'code', nameAr: 'باقة 101' })),
    ).toMatchObject({
      status: 409,
      code: 'CATALOG_LIMIT_REACHED',
    });
  });
});

describe('concurrency', () => {
  it('two creations with one name leave one', async () => {
    const category = await newCategory();
    const nameAr = unique('توأم');
    const results = await Promise.all(
      [1, 2].map(() =>
        post('/games', { categoryId: category.id, slug: unique('g'), nameAr, nameEn: 'Twin' }),
      ),
    );
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const created = results.find((response) => response.status === 201) as Response;
    gameIds.push(((await created.json()) as { id: string }).id);
    const [rows] = await Promise.all([
      test.db.select().from(catalogGames).where(eq(catalogGames.nameAr, nameAr)),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('two reorders of one game serialize to a consistent order', async () => {
    const game = await newGame((await newCategory()).id);
    const ids: string[] = [];
    for (const name of ['أ', 'ب', 'ج', 'د']) {
      ids.push(
        (
          await json<{ id: string }>(
            await post(`/games/${game.id}/products`, { kind: 'code', nameAr: name }),
            201,
          )
        ).id,
      );
    }
    const first = [...ids].reverse();
    const second = [ids[1], ids[3], ids[0], ids[2]] as string[];
    const results = await Promise.all([
      put(`/games/${game.id}/products/order`, { ids: first }),
      put(`/games/${game.id}/products/order`, { ids: second }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    const rows = await test.db
      .select({ id: catalogProducts.id, sortOrder: catalogProducts.sortOrder })
      .from(catalogProducts)
      .where(eq(catalogProducts.gameId, game.id))
      .orderBy(asc(catalogProducts.sortOrder));
    expect(rows.map((row) => row.sortOrder)).toEqual([1, 2, 3, 4]);
    expect([first, second]).toContainEqual(rows.map((row) => row.id));
  });

  it('two archives of the last two required fields leave one: the game stays complete', async () => {
    const game = await activeGame((await newCategory()).id);
    const field = game.fields[0] as { id: string };
    await json(
      await post(`/games/${game.id}/fields`, {
        key: 'zone_id',
        labelAr: 'المنطقة',
        type: 'digits',
        required: true,
      }),
      201,
    );
    const second = (await json<GameBody>(await get(`/games/${game.id}`), 200)).fields[1] as {
      id: string;
    };
    const results = await Promise.all([
      post(`/fields/${field.id}/archive`),
      post(`/fields/${second.id}/archive`),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const live = await test.db
      .select({ id: catalogInputFields.id })
      .from(catalogInputFields)
      .where(eq(catalogInputFields.gameId, game.id))
      .then((rows) => rows);
    expect(live).toHaveLength(2);
    const required = await test.db
      .select()
      .from(catalogInputFields)
      .where(eq(catalogInputFields.gameId, game.id));
    expect(required.filter((row) => row.archivedAt === null)).toHaveLength(1);
  });
});

describe('store routes (S09 rules SF1, SF5, SS1–SS3, SR2, AD1)', () => {
  it('serve the storefront, a game page and the search index publicly, cacheable, without cookies', async () => {
    const category = await newCategory();
    const shown = await activeGame(category.id);
    const paused = await newGame(category.id);
    for (const path of ['/api/catalog/storefront', '/api/catalog/search-index']) {
      const response = await client.get(path, { cookie: customerCookie });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=30');
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    const storefront = await json<{
      service: string;
      categories: { slug: string; games: { id: string; status: string }[] }[];
    }>(await client.get('/api/catalog/storefront'), 200);
    expect(['normal', 'slow']).toContain(storefront.service);
    const section = storefront.categories.find((entry) => entry.slug === category.slug);
    // A product with no route is out of stock: the game shows as unavailable (rule SS1).
    expect(section?.games).toEqual([
      expect.objectContaining({ id: shown.id, status: 'unavailable' }),
    ]);
    expect(JSON.stringify(storefront)).not.toContain(paused.id);

    const [row] = await test.db.select().from(catalogGames).where(eq(catalogGames.id, shown.id));
    const page = await json<{
      game: { id: string; status: string };
      fields: { key: string }[];
      products: { available: boolean; priceUsdUnits: number | null; playerCheck: boolean }[];
    }>(await client.get(`/api/catalog/games/${row?.slug}`), 200);
    expect(page.game).toMatchObject({ id: shown.id, status: 'unavailable' });
    expect(page.fields.map((field) => field.key)).toEqual(['player_id']);
    expect(page.products).toEqual([
      expect.objectContaining({ available: false, priceUsdUnits: null, playerCheck: false }),
    ]);
    const [pausedRow] = await test.db
      .select()
      .from(catalogGames)
      .where(eq(catalogGames.id, paused.id));
    expect(
      await json(await client.get(`/api/catalog/games/${pausedRow?.slug}`), 404),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect((await client.get('/api/catalog/games/no-such-game')).status).toBe(404);
    await json(await post(`/games/${shown.id}/archive`), 200);
    expect((await client.get(`/api/catalog/games/${row?.slug}`)).status).toBe(404);
  });

  it('stores search terms normalized and unique, audited with the game, in the index', async () => {
    const category = await newCategory();
    const game = await activeGame(category.id);
    expect(
      await json(await patch(`/games/${game.id}`, { searchTerms: ['ببجي', ' بَبجي '] }), 400),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const updated = await json<{ searchTerms: string[] }>(
      await patch(`/games/${game.id}`, { searchTerms: ['PUBG', 'بوبجي', 'أبجي'] }),
      200,
    );
    expect(updated.searchTerms).toEqual(['pubg', 'بوبجي', 'ابجي']);
    const entries = await auditOf(test.db, game.id);
    const termsEntry = entries.find(
      (entry) =>
        entry.action === 'catalog_game.updated' &&
        'searchTerms' in ((entry.details as { after?: object }).after ?? {}),
    );
    expect(termsEntry?.details).toMatchObject({
      before: { searchTerms: [] },
      after: { searchTerms: ['pubg', 'بوبجي', 'ابجي'] },
    });
    const index = await json<{ games: { id: string; searchTerms: string[] }[] }>(
      await client.get('/api/catalog/search-index'),
      200,
    );
    expect(index.games.find((entry) => entry.id === game.id)?.searchTerms).toEqual([
      'pubg',
      'بوبجي',
      'ابجي',
    ]);
  });

  it('serves a catalog image at the store widths, made once, never upscaled (rule SF5)', async () => {
    const response = await client.post('/api/admin/catalog/images', {
      cookie: admin.cookie,
      form: form(await image('png', 800)),
    });
    const { id } = await json<{ id: string }>(response, 201);
    const at = async (width: string) => {
      const served = await client.get(`/api/catalog/images/${id}?w=${width}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/webp');
      expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      return sharp(Buffer.from(await served.arrayBuffer())).metadata();
    };
    expect((await at('320')).width).toBe(320);
    expect((await at('320')).width).toBe(320);
    expect((await at('1280')).width).toBe(800);
    // Two first requests for one size at once: both get the whole image.
    const sizes = await Promise.all([at('640'), at('640'), at('640')]);
    expect(sizes.map((size) => size.width)).toEqual([640, 640, 640]);
    expect(await json(await client.get(`/api/catalog/images/${id}?w=500`), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
