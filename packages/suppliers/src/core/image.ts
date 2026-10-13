import type { ImageLimits } from './adapter.js';
import { SupplierError } from './errors.js';

/*
 * S16 IM1, IM2: a supplier's category image, fetched only from the hosts its adapter declares,
 * over HTTPS on the default port, without credentials in the URL. Redirects are followed by hand,
 * at most 3, and only to declared hosts; the body is read up to `maxBytes`, within `timeoutMs`
 * for the whole fetch. Every refusal is a definitive `SupplierError`: the caller shows a
 * placeholder or asks for an upload. The bytes are decoded and re-encoded by the caller.
 */

const MAX_REDIRECTS = 3;

/** Whether `url` is HTTPS on one of `hosts` (exact host names, default port, no user info). */
export function imageUrlAllowed(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    hosts.includes(parsed.hostname.toLowerCase())
  );
}

const refused = (message: string, status?: number) =>
  new SupplierError('definitive', message, {
    supplierCode: 'IMAGE_FETCH_FAILED',
    ...(status !== undefined && { status }),
  });

export async function fetchImageFromHosts(
  url: string,
  hosts: readonly string[],
  limits: ImageLimits,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let target = url;
  for (let hop = 0; ; hop += 1) {
    if (!imageUrlAllowed(target, hosts)) throw refused('Image URL is not on a declared host');
    let response: Response;
    try {
      response = await fetchFn(target, {
        redirect: 'manual',
        signal,
        headers: { accept: 'image/*' },
      });
    } catch (cause) {
      throw new SupplierError('retryable', 'Image could not be fetched', { cause });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) throw refused('Image redirects too often or nowhere');
      target = new URL(location, target).href;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw refused(`Image answered HTTP ${response.status}`, response.status);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw refused('Image is larger than allowed');
    }
    return readLimited(response.body, limits.maxBytes);
  }
}

async function readLimited(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw refused('Image is larger than allowed');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SupplierError) throw error;
    throw new SupplierError('retryable', 'Image could not be read', { cause: error });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
