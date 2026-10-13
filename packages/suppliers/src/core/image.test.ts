import { describe, expect, it } from 'vitest';
import { SupplierError } from './errors.js';
import { fetchImageFromHosts, imageUrlAllowed } from './image.js';

/*
 * S16 IM1, IM2: supplier images come only from declared HTTPS hosts, never through a redirect to
 * another host, within the size and time limits. `fetch` is scripted: nothing leaves the machine.
 */

const HOSTS = ['images.example.test'];
const LIMITS = { maxBytes: 8, timeoutMs: 1_000 };
const URL_OK = 'https://images.example.test/a.png';

type Script = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

const scripted = (script: Script) => {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return script(String(input), init);
  }) as typeof fetch;
  return { urls, fetchFn };
};

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof SupplierError ? error.kind : 'other'),
  );

describe('imageUrlAllowed', () => {
  it('takes HTTPS on a declared host and the default port only', () => {
    expect(imageUrlAllowed(URL_OK, HOSTS)).toBe(true);
    expect(imageUrlAllowed('https://IMAGES.example.test/a.png', HOSTS)).toBe(true);
    for (const url of [
      'http://images.example.test/a.png',
      'https://images.example.test:8443/a.png',
      'https://user:pass@images.example.test/a.png',
      'https://other.example.test/a.png',
      'https://sub.images.example.test/a.png',
      'not a url',
    ]) {
      expect(imageUrlAllowed(url, HOSTS)).toBe(false);
    }
  });
});

describe('fetchImageFromHosts', () => {
  it('reads the bytes without following redirects on its own', async () => {
    const { urls, fetchFn } = scripted((_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(new Uint8Array([1, 2, 3]));
    });
    expect(await fetchImageFromHosts(URL_OK, HOSTS, LIMITS, fetchFn)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(urls).toEqual([URL_OK]);
  });

  it('follows a redirect on a declared host, and refuses one elsewhere or without end', async () => {
    const redirect = (location: string | null) =>
      new Response(null, { status: 302, headers: location ? { location } : {} });
    const hop = scripted((url) =>
      url === URL_OK ? redirect('/b.png') : new Response(new Uint8Array([7])),
    );
    expect(await fetchImageFromHosts(URL_OK, HOSTS, LIMITS, hop.fetchFn)).toEqual(
      new Uint8Array([7]),
    );
    expect(hop.urls).toEqual([URL_OK, 'https://images.example.test/b.png']);

    const away = scripted(() => redirect('https://evil.test/x.png'));
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, away.fetchFn))).toBe(
      'definitive',
    );
    expect(away.urls).toEqual([URL_OK]);

    const loop = scripted(() => redirect(URL_OK));
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, loop.fetchFn))).toBe(
      'definitive',
    );
    expect(loop.urls).toHaveLength(4);
    const nowhere = scripted(() => redirect(null));
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, nowhere.fetchFn))).toBe(
      'definitive',
    );
  });

  it('refuses other hosts, error statuses and oversized bodies', async () => {
    const never = scripted(() => {
      throw new Error('must not be called');
    });
    expect(
      await refusal(fetchImageFromHosts('https://evil.test/a.png', HOSTS, LIMITS, never.fetchFn)),
    ).toBe('definitive');
    expect(never.urls).toEqual([]);

    const missing = scripted(() => new Response('nope', { status: 404 }));
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, missing.fetchFn))).toBe(
      'definitive',
    );
    const empty = scripted(() => new Response(null, { status: 200 }));
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, empty.fetchFn))).toBe(
      'definitive',
    );
    const declared = scripted(
      () => new Response(new Uint8Array(4), { headers: { 'content-length': '9' } }),
    );
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, declared.fetchFn))).toBe(
      'definitive',
    );
    const streamed = scripted(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5));
              controller.enqueue(new Uint8Array(5));
              controller.close();
            },
          }),
        ),
    );
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, streamed.fetchFn))).toBe(
      'definitive',
    );
  });

  it('turns network and stream failures into retryable errors', async () => {
    const down = scripted(() => {
      throw new TypeError('fetch failed');
    });
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, down.fetchFn))).toBe(
      'retryable',
    );
    const broken = scripted(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('reset'));
            },
          }),
        ),
    );
    expect(await refusal(fetchImageFromHosts(URL_OK, HOSTS, LIMITS, broken.fetchFn))).toBe(
      'retryable',
    );
  });
});
