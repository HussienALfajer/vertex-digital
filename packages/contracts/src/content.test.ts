import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MINIMUM,
  activityAge,
  activityVisible,
  announcementInputSchema,
  announcementState,
  bannerInputSchema,
  bannerOrderSchema,
  bannerState,
  CONTENT_PAGES,
  contentPagePath,
  faqOrderSchema,
  floorToFiveMinutes,
  formatDeliveryDuration,
  linkPathSchema,
  parseRichText,
  type RichBlock,
  richTextProblems,
  richTextSchema,
  saveFaqItemSchema,
  savePageDraftSchema,
} from './content.js';

const id = (n: number) => `0190f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const blocks = (source: string): RichBlock[] => parseRichText(source).blocks;
const reasons = (source: string) =>
  richTextProblems(source).map((problem) => `${problem.line}:${problem.reason}`);

describe('contentPagePath (audit A08-33)', () => {
  it('gives each page its store path', () => {
    expect(CONTENT_PAGES.map(contentPagePath)).toEqual([
      '/terms',
      '/privacy',
      '/refund',
      '/about',
      '/merchant-terms',
    ]);
  });
});

describe('linkPathSchema (MD4)', () => {
  it.each(['/', '/faq', '/games/pubg-mobile', '/terms#section-2', '/faq#q-0190f0a0', '/a.b_c~d/'])(
    'accepts %s',
    (path) => {
      expect(linkPathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    'faq',
    '//evil.example',
    'https://example.com',
    'javascript:alert(1)',
    '/search?q=1',
    '/a/../admin',
    '/..',
    '/../x',
    '/a/..#x',
    '/a b',
    '/terms#',
    '/terms#a.b',
    `/${'a'.repeat(200)}`,
  ])('refuses %s', (path) => {
    expect(linkPathSchema.safeParse(path).success).toBe(false);
  });

  it('accepts dots that are not a whole segment', () => {
    expect(linkPathSchema.safeParse('/a..b').success).toBe(true);
  });
});

describe('parseRichText (MD1, MD5)', () => {
  it('parses an empty source to nothing', () => {
    expect(parseRichText('')).toEqual({ blocks: [], problems: [] });
  });

  it('parses paragraphs with line breaks', () => {
    expect(blocks('سطر أول\r\nسطر ثانٍ\n\nفقرة')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'سطر أول' },
          { type: 'break' },
          { type: 'text', value: 'سطر ثانٍ' },
        ],
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'فقرة' }] },
    ]);
  });

  it('gives ## and ### headings stable ids', () => {
    expect(blocks('## أولاً ##\n### ثانياً\n##')).toEqual([
      { type: 'heading', level: 2, id: 'section-1', children: [{ type: 'text', value: 'أولاً' }] },
      { type: 'heading', level: 3, id: 'section-2', children: [{ type: 'text', value: 'ثانياً' }] },
      { type: 'heading', level: 2, id: 'section-3', children: [] },
    ]);
  });

  it('keeps a # without a space as text', () => {
    expect(blocks('#وسم')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '#وسم' }] },
    ]);
  });

  it('parses bold, italic, nesting and escapes', () => {
    expect(blocks('**غامق** و*مائل* و__غامق__ و_مائل_ و**غامق *ومائل* هنا**')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'strong', children: [{ type: 'text', value: 'غامق' }] },
          { type: 'text', value: ' و' },
          { type: 'emphasis', children: [{ type: 'text', value: 'مائل' }] },
          { type: 'text', value: ' و' },
          { type: 'strong', children: [{ type: 'text', value: 'غامق' }] },
          { type: 'text', value: ' و' },
          { type: 'emphasis', children: [{ type: 'text', value: 'مائل' }] },
          { type: 'text', value: ' و' },
          {
            type: 'strong',
            children: [
              { type: 'text', value: 'غامق ' },
              { type: 'emphasis', children: [{ type: 'text', value: 'ومائل' }] },
              { type: 'text', value: ' هنا' },
            ],
          },
        ],
      },
    ]);
    expect(blocks('\\*ليس مائلاً\\* و\\\\ و\\ق')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '*ليس مائلاً* و\\ و\\ق' }] },
    ]);
  });

  it('keeps unmatched or spaced delimiters as text', () => {
    const text = (source: string) => blocks(source)[0];
    expect(text('2 * 3 = 6')).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: '2 * 3 = 6' }],
    });
    expect(text('*a *')).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: '*a *' }],
    });
    expect(text('a*')).toEqual({ type: 'paragraph', children: [{ type: 'text', value: 'a*' }] });
    expect(text('**a')).toEqual({ type: 'paragraph', children: [{ type: 'text', value: '**a' }] });
    expect(text('*a\\*b*')).toEqual({
      type: 'paragraph',
      children: [{ type: 'emphasis', children: [{ type: 'text', value: 'a*b' }] }],
    });
    expect(text('*a**b*')).toEqual({
      type: 'paragraph',
      children: [{ type: 'emphasis', children: [{ type: 'text', value: 'a**b' }] }],
    });
  });

  it('parses internal links and keeps links out of link labels', () => {
    expect(blocks('اقرأ [**الأسئلة**](/faq) و[أ [ب](/b)](/a)')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'اقرأ ' },
          {
            type: 'link',
            href: '/faq',
            children: [{ type: 'strong', children: [{ type: 'text', value: 'الأسئلة' }] }],
          },
          { type: 'text', value: ' و[أ ' },
          { type: 'link', href: '/b', children: [{ type: 'text', value: 'ب' }] },
          { type: 'text', value: '](/a)' },
        ],
      },
    ]);
    expect(blocks('[نص] (/faq) و[نص]')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '[نص] (/faq) و[نص]' }] },
    ]);
  });

  it('parses bulleted and numbered lists two levels deep', () => {
    expect(blocks('- أ\n  تابع\n  - أ1\n  1. أ2\n- ب\nكسول\n\n- ج\n\nفقرة')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            children: [
              { type: 'text', value: 'أ' },
              { type: 'break' },
              { type: 'text', value: 'تابع' },
            ],
            list: {
              type: 'list',
              ordered: true,
              start: 1,
              items: [{ children: [{ type: 'text', value: 'أ2' }], list: null }],
            },
          },
          {
            children: [
              { type: 'text', value: 'ب' },
              { type: 'break' },
              { type: 'text', value: 'كسول' },
            ],
            list: null,
          },
          { children: [{ type: 'text', value: 'ج' }], list: null },
        ],
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'فقرة' }] },
    ]);
    expect(blocks('3) ثالث\n4) رابع\n   - فرعي\n   - فرعي')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          { children: [{ type: 'text', value: 'ثالث' }], list: null },
          {
            children: [{ type: 'text', value: 'رابع' }],
            list: {
              type: 'list',
              ordered: false,
              start: 1,
              items: [
                { children: [{ type: 'text', value: 'فرعي' }], list: null },
                { children: [{ type: 'text', value: 'فرعي' }], list: null },
              ],
            },
          },
        ],
      },
    ]);
  });

  it('ends a list at another kind, a heading, a quote or a blank line before text', () => {
    expect(blocks('- أ\n1. ب').map((block) => block.type)).toEqual(['list', 'list']);
    expect(blocks('- أ\n## ب').map((block) => block.type)).toEqual(['list', 'heading']);
    expect(blocks('- أ\n> ب').map((block) => block.type)).toEqual(['list', 'quote']);
    expect(blocks('- أ\n\n\nب').map((block) => block.type)).toEqual(['list', 'paragraph']);
    expect(blocks('- أ\n\n').map((block) => block.type)).toEqual(['list']);
    expect(blocks('- أ\n').map((block) => block.type)).toEqual(['list']);
    expect(blocks('  - أ\n\n- ب').map((block) => block.type)).toEqual(['list', 'list']);
    expect(blocks('  - أ\n- ب').map((block) => block.type)).toEqual(['list', 'list']);
  });

  it('starts a list inside text only with a bullet or the number 1', () => {
    expect(blocks('نص\n- أ').map((block) => block.type)).toEqual(['paragraph', 'list']);
    expect(blocks('نص\n1. أ').map((block) => block.type)).toEqual(['paragraph', 'list']);
    expect(blocks('العام\n2024. سنة')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'العام' },
          { type: 'break' },
          { type: 'text', value: '2024. سنة' },
        ],
      },
    ]);
  });

  it('parses quotes with blocks inside', () => {
    expect(blocks('> ## مهم\n>نص\n> - أ\nبعد')).toEqual([
      {
        type: 'quote',
        children: [
          {
            type: 'heading',
            level: 2,
            id: 'section-1',
            children: [{ type: 'text', value: 'مهم' }],
          },
          { type: 'paragraph', children: [{ type: 'text', value: 'نص' }] },
          {
            type: 'list',
            ordered: false,
            start: 1,
            items: [{ children: [{ type: 'text', value: 'أ' }], list: null }],
          },
        ],
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'بعد' }] },
    ]);
  });

  it('keeps indented lines inside a paragraph as text', () => {
    expect(blocks('نص\n    متابعة')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'نص' },
          { type: 'break' },
          { type: 'text', value: 'متابعة' },
        ],
      },
    ]);
  });
});

describe('richTextProblems (MD2)', () => {
  it('finds nothing in allowed text', () => {
    expect(reasons('## عنوان\n**غامق** [رابط](/faq)\n- قائمة\n> اقتباس\na < b and 3<4')).toEqual(
      [],
    );
  });

  it('refuses raw HTML and autolinks on their lines, escaped ones aside', () => {
    expect(reasons('نص\n<b>x</b>\n> <script>\n- <!-- -->\n<https://x.y>\n\\<b>')).toEqual([
      '2:html',
      '3:html',
      '4:html',
      '5:html',
    ]);
    expect(blocks('<b>x</b>')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '<b>x</b>' }] },
    ]);
  });

  it('refuses images and drops them', () => {
    expect(reasons('صورة ![x](/a.png) هنا')).toEqual(['1:image']);
    expect(blocks('صورة ![x](/a.png) هنا')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'صورة  هنا' }] },
    ]);
    expect(blocks('![x] نص')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '![x] نص' }] },
    ]);
    expect(blocks('!مهم')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '!مهم' }] },
    ]);
  });

  it('refuses external or malformed link targets and keeps their text', () => {
    expect(reasons('[x](https://example.com)\n[y](//evil)\n[z]()')).toEqual([
      '1:link',
      '2:link',
      '3:link',
    ]);
    expect(blocks('زر [موقع](https://example.com) الآن')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'زر موقع الآن' }] },
    ]);
  });

  it('refuses # and #### headings and setext titles', () => {
    expect(reasons('# عنوان\n#### صغير\nنص\n===')).toEqual([
      '1:heading_level',
      '2:heading_level',
      '4:heading_level',
    ]);
    expect(blocks('# عنوان')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'عنوان' }] },
    ]);
    expect(reasons('===')).toEqual([]);
  });

  it('refuses tables, code blocks and horizontal rules', () => {
    expect(reasons('| أ | ب |\n|---|---|\nأ | ب\n--- | ---')).toEqual([
      '1:table',
      '2:table',
      '4:table',
    ]);
    expect(reasons('```\ncode\n```\n~~~')).toEqual(['1:code', '3:code', '4:code']);
    expect(reasons('    code\n\tcode')).toEqual(['1:code']);
    expect(reasons('---\n* * *\nنص\n___')).toEqual(['1:rule', '2:rule', '4:rule']);
  });

  it('refuses a third list level and keeps it as text', () => {
    expect(reasons('- أ\n  - ب\n    - ج')).toEqual(['3:list_depth']);
    const [list] = blocks('- أ\n  - ب\n    - ج');
    expect(list).toMatchObject({
      items: [
        {
          list: {
            items: [
              {
                children: [
                  { type: 'text', value: 'ب' },
                  { type: 'break' },
                  { type: 'text', value: 'ج' },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  it('reports the problems inside a list and a quote by line', () => {
    expect(reasons('- أ\n- [x](https://x.y)\n  - ![i](/i)\n> # ب')).toEqual([
      '2:link',
      '3:image',
      '4:heading_level',
    ]);
    expect(reasons('- أ\n---')).toEqual(['2:rule']);
    expect(reasons('- أ\n| ب |')).toEqual(['2:table']);
    expect(reasons('- أ\n```')).toEqual(['2:code']);
  });
});

describe('richTextSchema', () => {
  it('puts each problem at its line', () => {
    const result = richTextSchema(100).safeParse('نص\n<b>x</b>');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: [2], message: 'html' },
    ]);
  });

  it('keeps the source as written and refuses control characters and length', () => {
    expect(richTextSchema(100).parse('  نص\r\n\tب  ')).toBe('  نص\r\n\tب  ');
    expect(richTextSchema(100).safeParse('a\u0000').success).toBe(false);
    expect(richTextSchema(3).safeParse('abcd').success).toBe(false);
  });

  it('accepts an empty draft and refuses an empty answer', () => {
    expect(savePageDraftSchema.parse({ title: ' الشروط ', body: '', revision: 0 })).toEqual({
      title: 'الشروط',
      body: '',
      revision: 0,
    });
    expect(
      saveFaqItemSchema.safeParse({ sectionId: id(1), question: 'سؤال طويل؟', answer: '  ' })
        .success,
    ).toBe(false);
    expect(
      saveFaqItemSchema.safeParse({ sectionId: id(1), question: 'سؤال طويل؟', answer: 'جواب' })
        .success,
    ).toBe(true);
  });
});

describe('schedules (BN4, AN1)', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const row = { enabled: true, startsAt: null, endsAt: null, archivedAt: null };

  it.each([
    [{ ...row, archivedAt: at(-1), enabled: false }, 'archived'],
    [{ ...row, enabled: false }, 'disabled'],
    [{ ...row, endsAt: now }, 'ended'],
    [{ ...row, startsAt: at(1) }, 'scheduled'],
    [{ ...row, startsAt: now, endsAt: at(1) }, 'live'],
    [row, 'live'],
  ] as const)('%o is %s', (value, state) => {
    expect(bannerState(value, now)).toBe(state);
    expect(announcementState(value, now)).toBe(state);
  });

  it('refuses an end before its start', () => {
    const banner = { imageFileId: id(1), altText: 'بانر' };
    expect(
      bannerInputSchema.safeParse({
        ...banner,
        startsAt: '2026-10-12T10:00:00+03:00',
        endsAt: '2026-10-12T07:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      bannerInputSchema.parse({ ...banner, startsAt: null, endsAt: '2026-10-12T07:00:00Z' }),
    ).toMatchObject({ endsAt: '2026-10-12T07:00:00Z' });
    expect(
      announcementInputSchema.parse({
        text: 'عرض خاص',
        startsAt: '2026-10-12T07:00:00Z',
        endsAt: '2026-10-12T08:00:00Z',
      }),
    ).toMatchObject({ tone: 'info' });
  });

  it('refuses external links on banners and announcements', () => {
    expect(
      announcementInputSchema.safeParse({ text: 'عرض خاص', linkPath: 'https://x.y' }).success,
    ).toBe(false);
  });
});

describe('orders of ids (FQ4, BN6)', () => {
  it('refuses an id twice', () => {
    expect(bannerOrderSchema.safeParse({ ids: [id(1), id(1)] }).success).toBe(false);
    expect(
      faqOrderSchema.safeParse({
        sections: [
          { id: id(1), itemIds: [] },
          { id: id(1), itemIds: [] },
        ],
      }).success,
    ).toBe(false);
    expect(
      faqOrderSchema.safeParse({ sections: [{ id: id(1), itemIds: [id(2), id(3)] }] }).success,
    ).toBe(true);
  });
});

describe('live activity (LA3–LA5)', () => {
  it('shows from the minimum', () => {
    expect(activityVisible(ACTIVITY_MINIMUM - 1)).toBe(false);
    expect(activityVisible(ACTIVITY_MINIMUM)).toBe(true);
  });

  it('floors times to 5 minutes', () => {
    expect(floorToFiveMinutes(new Date('2026-10-11T12:09:59.999Z')).toISOString()).toBe(
      '2026-10-11T12:05:00.000Z',
    );
    expect(floorToFiveMinutes(new Date('2026-10-11T12:10:00Z')).toISOString()).toBe(
      '2026-10-11T12:10:00.000Z',
    );
  });

  it.each([
    [-3, { unit: 'seconds', count: 1 }],
    [0, { unit: 'seconds', count: 1 }],
    [14.7, { unit: 'seconds', count: 14 }],
    [59, { unit: 'seconds', count: 59 }],
    [60, { unit: 'minutes', count: 1 }],
    [3599, { unit: 'minutes', count: 59 }],
    [3600, { unit: 'hours', count: 1 }],
    [3 * 3600 + 59 * 60, { unit: 'hours', count: 3 }],
  ])('%s seconds read %o', (seconds, expected) => {
    expect(formatDeliveryDuration(seconds)).toEqual(expected);
  });

  it.each([
    ['12:05', { unit: 'minutes', count: 5 }],
    ['12:09', { unit: 'minutes', count: 5 }],
    ['12:10', { unit: 'minutes', count: 10 }],
    ['12:59', { unit: 'minutes', count: 55 }],
    ['13:00', { unit: 'hours', count: 1 }],
    ['23:59', { unit: 'hours', count: 11 }],
  ])('a delivery at 12:00 read at %s is %o ago', (time, expected) => {
    const deliveredAt = new Date('2026-10-11T12:00:00Z');
    expect(activityAge(deliveredAt, new Date(`2026-10-11T${time}:00Z`))).toEqual(expected);
  });

  it('reads a time not yet 5 minutes old as 5 minutes', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(activityAge(now, now)).toEqual({ unit: 'minutes', count: 5 });
  });
});
