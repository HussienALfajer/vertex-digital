import {
  isRateSourceHandle,
  parseSourceFigure,
  type RateSourceKind,
  type RateSourceParser,
} from '@vertex-digital/contracts';

/*
 * S27 SR1, SR2, SR5 (ADR 0041): reads one public rate source. Hosts are fixed here, never taken
 * from the panel: a source names a Telegram channel's username or a "الليرة اليوم" page path,
 * checked again before any request. One GET per read, no cookies or credentials, no redirect
 * followed (a redirect is a failed read), at most 2 MB within 10 seconds. A read never throws:
 * every failure is a status the caller stores. Whether the figure is in range of the current
 * rate (SR3) is the caller's decision.
 */

export const RATE_FEED_HOSTS = { telegram_channel: 't.me', sp_today_page: 'sp-today.com' } as const;

const MAX_BYTES = 2 * 1024 * 1024;

export const RATE_FEED_TIMEOUT_MS = 10_000;

/** The page of a source: `https://t.me/s/<channel>` or `https://sp-today.com<path>`. */
export function rateSourceUrl(kind: RateSourceKind, handle: string): string {
  if (!isRateSourceHandle(kind, handle)) throw new RangeError('Invalid rate source handle');
  return kind === 'telegram_channel'
    ? `https://${RATE_FEED_HOSTS.telegram_channel}/s/${handle}`
    : `https://${RATE_FEED_HOSTS.sp_today_page}${handle}`;
}

export interface RateSourceRead {
  status: 'ok' | 'no_match' | 'fetch_failed';
  sypPerUsd: string | null;
  postedAt: Date | null;
  excerpt: string | null;
  /** Why a read failed: `timeout`, `network`, `redirect`, `http_<status>`, `too_large`, `invalid_handle`. */
  errorCode: string | null;
}

export interface ReadRateSourceOptions {
  fetch?: typeof fetch;
  /** Names the store's public site; never personal data. */
  userAgent: string;
  timeoutMs?: number;
}

const failed = (errorCode: string): RateSourceRead => ({
  status: 'fetch_failed',
  sypPerUsd: null,
  postedAt: null,
  excerpt: null,
  errorCode,
});

/** Reads a source once and parses its newest matching figure (SR2). */
export async function readRateSource(
  source: { kind: RateSourceKind; handle: string; parser: RateSourceParser },
  options: ReadRateSourceOptions,
): Promise<RateSourceRead> {
  const fetchFn = options.fetch ?? fetch;
  // A row written past the panel's check is never read: no request leaves for another host.
  if (!isRateSourceHandle(source.kind, source.handle)) return failed('invalid_handle');
  let page: string;
  try {
    const response = await fetchFn(rateSourceUrl(source.kind, source.handle), {
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(options.timeoutMs ?? RATE_FEED_TIMEOUT_MS),
      headers: { 'user-agent': options.userAgent, accept: 'text/html' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return failed('redirect');
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return failed(`http_${response.status}`);
    }
    const text = await readLimited(response.body, MAX_BYTES);
    if (text === null) return failed('too_large');
    page = text;
  } catch (error) {
    const name = (error as Error).name;
    return failed(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  const posts =
    source.kind === 'telegram_channel'
      ? telegramPosts(page)
      : [{ text: spTodayText(page), postedAt: null }];
  for (const post of posts) {
    const figure = parseSourceFigure(post.text, source.parser);
    if (figure) {
      return {
        status: 'ok',
        sypPerUsd: figure.sypPerUsd,
        postedAt: post.postedAt,
        excerpt: figure.excerpt,
        errorCode: null,
      };
    }
  }
  return { status: 'no_match', sypPerUsd: null, postedAt: null, excerpt: null, errorCode: null };
}

async function readLimited(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Text of an HTML fragment: `<br>` and block ends as new lines, tags dropped, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
}

const MESSAGE_TEXT = /<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/;
const MESSAGE_TIME = /<time datetime="([^"]+)"[^>]*class="time"/;

/**
 * SR2: the posts of a channel's public preview, newest first, with their times. The preview lists
 * them oldest first; a reply's quoted text (`js-message_reply_text`) is never read.
 */
export function telegramPosts(html: string): { text: string; postedAt: Date | null }[] {
  return html
    .split('tgme_widget_message_wrap')
    .slice(1)
    .flatMap((chunk) => {
      const text = MESSAGE_TEXT.exec(chunk)?.[1];
      if (text === undefined) return [];
      const time = MESSAGE_TIME.exec(chunk)?.[1];
      const postedAt = time ? new Date(time) : null;
      return [
        {
          text: htmlToText(text),
          postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
        },
      ];
    })
    .reverse();
}

/**
 * SR2: a "الليرة اليوم" page as one line of its visible body text, so a label and its figure on
 * separate elements («بيع» then «150.75») read as one line. The page shows no update time.
 */
export function spTodayText(html: string): string {
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, '');
  const visible = body.replace(/<(script|style|svg|head)[\s\S]*?<\/\1>/gi, ' ');
  // Every tag is a space: a label and its figure in adjacent elements stay two words.
  return htmlToText(visible.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
