import { parseRichText } from '@vertex-digital/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announcementKey,
  DISMISSED_KEY,
  DISMISSED_SCRIPT,
  readDismissed,
  writeDismissed,
} from './dismissal';
import { ageText, durationText, pageDescription, productText, updatedText } from './texts';

describe('durationText (S14 LA5)', () => {
  it.each([
    [0, 'خلال ثانية واحدة'],
    [2, 'خلال ثانيتين'],
    [3, 'خلال 3 ثوانٍ'],
    [14, 'خلال 14 ثانية'],
    [60, 'خلال دقيقة'],
    [180, 'خلال 3 دقائق'],
    [11 * 60, 'خلال 11 دقيقة'],
    [7200, 'خلال ساعتين'],
    [3 * 3600, 'خلال 3 ساعات'],
  ])('%s seconds read "%s"', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });
});

describe('ageText (S14 LA4)', () => {
  const delivered = '2026-10-11T12:00:00.000Z';
  it.each([
    ['12:03', 'منذ نحو 5 دقائق'],
    ['12:10', 'منذ نحو 10 دقائق'],
    ['12:25', 'منذ نحو 25 دقيقة'],
    ['13:10', 'منذ نحو ساعة'],
    ['14:00', 'منذ نحو ساعتين'],
    ['17:00', 'منذ نحو 5 ساعات'],
  ])('read at %s: "%s"', (time, text) => {
    expect(ageText(delivered, new Date(`2026-10-11T${time}:00.000Z`))).toBe(text);
  });
});

describe('updatedText (S14 PG2)', () => {
  it('names the day in Damascus with Latin digits', () => {
    // 22:30 UTC is already the next day in Damascus (UTC+3).
    expect(updatedText('2026-10-10T22:30:00.000Z')).toBe('آخر تحديث: 11 أكتوبر 2026');
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

describe('productText (S14 LA2)', () => {
  it('adds the quantity above 1', () => {
    expect(productText({ productNameAr: '60 UC', quantity: 1 })).toBe('60 UC');
    expect(productText({ productNameAr: '60 UC', quantity: 2 })).toBe('60 UC × 2');
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
