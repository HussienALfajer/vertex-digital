import { parseRichText } from '@vertex-digital/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announcementKey,
  DISMISSED_KEY,
  DISMISSED_SCRIPT,
  readDismissed,
  writeDismissed,
} from './dismissal';
import { pageDescription, updatedText } from './texts';

describe('updatedText (S14 PG2)', () => {
  it('names the day in Damascus with Latin digits', () => {
    // 22:30 UTC is already the next day in Damascus (UTC+3).
    expect(updatedText('2026-10-10T22:30:00.000Z')).toBe('آخر تحديث: 11 تشرين الأول 2026');
  });
});

describe('pageDescription', () => {
  it('takes the first paragraph as plain text', () => {
    const { blocks } = parseRichText('## عنوان\n\nنص **غامق**\nو[رابط](/faq)\n\nثانية');
    expect(pageDescription(blocks)).toBe('نص غامق ورابط');
  });

  it('cuts at 160 characters, and has none without a paragraph', () => {
    const long = 'ا'.repeat(200);
    expect(pageDescription(parseRichText(long).blocks)).toHaveLength(160);
    expect(pageDescription(parseRichText('## عنوان').blocks)).toBeUndefined();
  });
});

describe('announcement dismissal (S14 AN4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keys the bar by id and revision, so an edit shows it again', () => {
    expect(announcementKey('a', 1)).toBe('a:1');
    expect(announcementKey('a', 2)).not.toBe(announcementKey('a', 1));
  });

  it('remembers the closed bar on the device', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(readDismissed()).toBeNull();
    expect(writeDismissed('a:1')).toBe(true);
    expect(store.get(DISMISSED_KEY)).toBe('a:1');
    expect(readDismissed()).toBe('a:1');
  });

  it('works without storage, for the page view only', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readDismissed()).toBeNull();
    expect(writeDismissed('a:1')).toBe(false);
  });

  it('hides a closed bar before it paints, with a constant script', () => {
    const bar = { hidden: false, getAttribute: () => 'a:1' };
    const run = (stored: string | null) => {
      bar.hidden = false;
      new Function('document', 'localStorage', DISMISSED_SCRIPT)(
        { currentScript: { previousElementSibling: bar } },
        { getItem: () => stored },
      );
      return bar.hidden;
    };
    expect(run('a:1')).toBe(true);
    expect(run('a:0')).toBe(false);
    expect(run(null)).toBe(false);
  });
});
