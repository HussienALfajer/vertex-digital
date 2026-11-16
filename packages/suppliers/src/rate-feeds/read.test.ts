import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeRateFeedFile, fileRateFetch, writeFakeTelegramPost } from './fake.js';
import { htmlToText, rateSourceUrl, readRateSource, spTodayText, telegramPosts } from './read.js';

/*
 * S27 SR1, SR2, SR5 against recorded, sanitized page fixtures; never the live sites.
 */

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const userAgent = 'VertexDigitalRates/1.0 (+https://digital.example)';
const damascus = { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' } as const;
const channel = { kind: 'telegram_channel', handle: 'example_rates', parser: damascus } as const;

/** A `fetch` that answers every request with `response`, recording what it was asked. */
function scripted(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('rate source pages (S27 SR2)', () => {
  it('builds the page only on the fixed hosts', () => {
    expect(rateSourceUrl('telegram_channel', 'example_rates')).toBe('https://t.me/s/example_rates');
    expect(rateSourceUrl('sp_today_page', '/currency/us-dollar')).toBe(
      'https://sp-today.com/currency/us-dollar',
    );
    for (const [kind, handle] of [
      ['telegram_channel', 'evil.com/x'],
      ['sp_today_page', '//evil.com'],
      ['sp_today_page', '@evil.com'],
    ] as const) {
      expect(() => rateSourceUrl(kind, handle)).toThrow(RangeError);
    }
  });

  it('reads a channel preview newest first, never a reply quote', async () => {
    const posts = telegramPosts(await fixture('telegram-preview.html'));
    expect(posts).toHaveLength(3);
    expect(posts[0]).toEqual({
      text: 'صباح الخير للجميع ☀️',
      postedAt: new Date('2026-11-16T11:00:00Z'),
    });
    expect(posts[1]?.text).toContain('دمشق: شراء ١٣٠٫٥٠ | مبيع ١٣١٫٠٠');
    expect(posts[1]?.text).toContain('للاستفسار & الحجز');
    expect(posts[1]?.text).not.toContain('129.50');
  });

  it('reads a sp-today page as its visible body text', async () => {
    const text = spTodayText(await fixture('sp-today-us-dollar.html'));
    expect(text).toContain('بيع 131.75 ل.س جديدة');
    expect(text).not.toMatch(/999|888|777|9999/);
    expect(text).not.toContain('\n');
  });

  it('decodes entities and keeps unknown ones', () => {
    expect(htmlToText('a&nbsp;b &#x1F1F8;&#1604; &bogus; &#0; <i>x</i><br>y')).toBe(
      'a b 🇸ل &bogus; &#0; x\ny',
    );
  });
});

describe('reading a source (S27 SR1)', () => {
  it('finds the newest matching post with its time', async () => {
    const page = await fixture('telegram-preview.html');
    const { calls, fetchFn } = scripted(() => new Response(page, { status: 200 }));
    expect(await readRateSource(channel, { fetch: fetchFn, userAgent })).toEqual({
      status: 'ok',
      sypPerUsd: '131',
      postedAt: new Date('2026-11-16T10:31:40Z'),
      excerpt: 'دمشق: شراء 130.50 | مبيع 131.00',
      errorCode: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://t.me/s/example_rates');
    expect(calls[0]?.init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(new Headers(calls[0]?.init?.headers).get('user-agent')).toBe(userAgent);
  });

  it('reads the sell figure of a sp-today page without a post time', async () => {
    const page = await fixture('sp-today-us-dollar.html');
    const { fetchFn } = scripted(() => new Response(page, { status: 200 }));
    const source = {
      kind: 'sp_today_page',
      handle: '/currency/us-dollar',
      parser: { cityWord: null, sellWord: 'بيع', unit: 'new_syp' },
    } as const;
    expect(await readRateSource(source, { fetch: fetchFn, userAgent })).toMatchObject({
      status: 'ok',
      sypPerUsd: '131.75',
      postedAt: null,
    });
  });

  it('answers no_match when no post has the keywords', async () => {
    const page = await fixture('telegram-preview.html');
    const { fetchFn } = scripted(() => new Response(page, { status: 200 }));
    const homs = { ...channel, parser: { ...damascus, cityWord: 'حمص' } };
    expect(await readRateSource(homs, { fetch: fetchFn, userAgent })).toEqual({
      status: 'no_match',
      sypPerUsd: null,
      postedAt: null,
      excerpt: null,
      errorCode: null,
    });
  });

  it('turns every failure into a failed read, never a throw', async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [
        () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
        'redirect',
      ],
      [() => new Response('gone', { status: 404 }), 'http_404'],
      [() => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }), 'too_large'],
      [
        () => {
          throw new TypeError('fetch failed');
        },
        'network',
      ],
      [
        () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
        'timeout',
      ],
    ];
    for (const [response, errorCode] of cases) {
      const { fetchFn } = scripted(response);
      expect(await readRateSource(channel, { fetch: fetchFn, userAgent })).toMatchObject({
        status: 'fetch_failed',
        errorCode,
      });
    }
  });

  it('never sends a request for a handle that does not fit its kind', async () => {
    const { calls, fetchFn } = scripted(() => new Response('', { status: 200 }));
    const evil = { ...channel, handle: 'evil.example/x' };
    expect(await readRateSource(evil, { fetch: fetchFn, userAgent })).toMatchObject({
      status: 'fetch_failed',
      errorCode: 'invalid_handle',
    });
    expect(calls).toEqual([]);
  });

  it('times out a slow source', async () => {
    const fetchFn = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    expect(
      await readRateSource(channel, { fetch: fetchFn, userAgent, timeoutMs: 20 }),
    ).toMatchObject({ status: 'fetch_failed', errorCode: 'timeout' });
  });
});

describe('the fake feed (RATE_FEED=fake)', () => {
  let dir = '';
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('serves pages written by the fake-post writer, and 404 for the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rate-feed-'));
    const fetchFn = fileRateFetch(dir);
    expect(fakeRateFeedFile(dir, 'https://sp-today.com/currency/us-dollar')).toBe(
      join(dir, 'sp_today_page', 'currency_us-dollar.html'),
    );
    expect(fakeRateFeedFile(dir, 'https://evil.example/x')).toBeNull();
    expect((await fetchFn('https://evil.example/x')).status).toBe(404);
    expect(await readRateSource(channel, { fetch: fetchFn, userAgent })).toMatchObject({
      status: 'fetch_failed',
      errorCode: 'http_404',
    });
    await writeFakeTelegramPost(
      dir,
      'example_rates',
      'دمشق مبيع 131',
      new Date('2026-11-16T09:00:00Z'),
    );
    await writeFakeTelegramPost(
      dir,
      'example_rates',
      'دمشق <b>مبيع</b> 131.5',
      new Date('2026-11-16T09:15:00Z'),
    );
    expect(await readRateSource(channel, { fetch: fetchFn, userAgent })).toMatchObject({
      status: 'ok',
      sypPerUsd: '131.5',
      postedAt: new Date('2026-11-16T09:15:00Z'),
      excerpt: 'دمشق <b>مبيع</b> 131.5',
    });
    for (let post = 0; post < 25; post += 1) {
      await writeFakeTelegramPost(dir, 'example_rates', `post ${post}`, new Date());
    }
    const page = await readFile(join(dir, 'telegram_channel', 'example_rates.html'), 'utf8');
    expect(telegramPosts(page)).toHaveLength(20);
    expect((await fetchFn(new URL('https://t.me/s/example_rates'))).status).toBe(200);
  });
});
