import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RATE_FEED_HOSTS } from './read.js';

/*
 * S27 local development (`RATE_FEED=fake`): a `fetch` that serves rate source pages from files
 * instead of the network, and the writer of the `rates:fake-post` CLI. A channel's page is
 * `<dir>/telegram_channel/<handle>.html`; a sp-today page is `<dir>/sp_today_page/<path>.html`
 * with the path's slashes as `_` (`/currency/us-dollar` → `currency_us-dollar.html`). A missing
 * file answers 404, like a channel without a public preview.
 */

/** The file of a source page, or null for a URL that is not one of the fixed hosts. */
export function fakeRateFeedFile(dir: string, url: string): string | null {
  const { hostname, pathname } = new URL(url);
  if (hostname === RATE_FEED_HOSTS.telegram_channel && pathname.startsWith('/s/')) {
    return join(dir, 'telegram_channel', `${pathname.slice(3)}.html`);
  }
  if (hostname === RATE_FEED_HOSTS.sp_today_page) {
    return join(dir, 'sp_today_page', `${pathname.slice(1).replaceAll('/', '_')}.html`);
  }
  return null;
}

export function fileRateFetch(dir: string): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const file = fakeRateFeedFile(dir, url);
    if (!file) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file, 'utf8'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Adds a post to a fake channel's page, as Telegram's preview shows it (oldest first), keeping the
 * last 20 posts. Returns the file written.
 */
export async function writeFakeTelegramPost(
  dir: string,
  handle: string,
  text: string,
  at: Date,
): Promise<string> {
  const folder = join(dir, 'telegram_channel');
  const file = join(folder, `${handle}.html`);
  await mkdir(folder, { recursive: true });
  const previous = await readFile(file, 'utf8').catch(() => '');
  const posts =
    previous.match(/<div class="tgme_widget_message_wrap[\s\S]*?<!-- end post -->/g) ?? [];
  const post = [
    '<div class="tgme_widget_message_wrap js-widget_message_wrap">',
    `<div class="tgme_widget_message_text js-message_text" dir="auto">${escapeHtml(text).replaceAll('\n', '<br/>')}</div>`,
    `<a class="tgme_widget_message_date"><time datetime="${at.toISOString()}" class="time">${at.toISOString()}</time></a>`,
    '</div><!-- end post -->',
  ].join('');
  const page = `<!DOCTYPE html><html><body>${[...posts, post].slice(-20).join('\n')}</body></html>\n`;
  await writeFile(file, page, 'utf8');
  return file;
}
