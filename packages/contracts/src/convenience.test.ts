import { describe, expect, it } from 'vitest';
import {
  CART_LINES_MAX,
  canonicalFields,
  cartLineKey,
  checkoutRequestSchema,
  checkoutTotal,
  createOrderSchema,
  giftSchema,
  giftTextAllowed,
  maskFieldValue,
  ORDER_STATUSES,
  receiptOptionsSchema,
  revokeShareLinkSchema,
  SHAREABLE_ORDER_STATUSES,
  savedPlayerLabelSchema,
  shareImageQuerySchema,
  shareStage,
  shareTokenSchema,
} from './orders.js';

/* S10: saved player ids, gifts, the cart and share links (`orders.ts`). */

const productId = '0190a2b4-0000-7000-8000-000000000001';

describe('gift texts (rule GF3)', () => {
  it.each([
    'كل عام وأنت بخير',
    'Happy birthday Ahmad!',
    'رقمي المفضل 123456',
    'هدية رقم ١٢٣٤٥٦',
    'مبروك… إلى اللقاء. نراك',
    'بالتوفيق @ab',
    'نصف‌فاصل و‍واصل',
    '',
  ])('allows %j', (text) => {
    expect(giftTextAllowed(text)).toBe(true);
  });

  it.each([
    ['a link', 'زورونا https://example.org'],
    ['a scheme without www', 'ftp://files'],
    ['www.', 'www.example'],
    ['a domain', 'تواصل example.com'],
    ['a domain in Arabic text', 'موقعنا vertex.io الآن'],
    ['a handle', 'تابعني @ahmad_99'],
    ['an Arabic handle', 'حسابي @احمد'],
    ['a phone number', 'تواصل معي 0933123456'],
    ['a spaced phone number', 'اتصل 09 33 12 34 56'],
    ['a dotted phone number', '0933.123.456'],
    ['a dashed phone number', '0933-123-456'],
    ['Arabic-Indic digits', 'رقمي ٠٩٣٣١٢٣٤٥٦'],
    ['Persian digits', 'رقمي ۰۹۳۳۱۲۳۴۵۶'],
    ['full-width digits', 'رقمي ０９３３１２３４５６'],
    ['a full-width @', 'تابعني ＠ahmad'],
    ['a bidi override', 'مرحبا ‮abc'],
    ['a bidi isolate', 'مرحبا ⁧abc'],
    ['a zero-width space', 'w​ww.example'],
    ['a zero-width no-break space', 'مرحبا﻿'],
    ['a newline', 'سطر\nآخر'],
    ['a control character', 'a\u0007b'],
    ['a phone number split by joiners', 'تواصل معي 0933\u200C123\u200D456'],
    ['a handle after a joiner', 'تابعني @\u200Cscammer'],
    ['a domain after a joiner', 'زوروا t.\u200Cme/scammer'],
    ['a combining grapheme joiner', 'scam.\u034Fcom'],
    ['a variation selector', '@sc\uFE0Fammer'],
    ['an ideographic full stop', 'scam\u3002com'],
    ['a halfwidth full stop', 'scam\uFF61com'],
  ])('refuses %s', (_, text) => {
    expect(giftTextAllowed(text)).toBe(false);
  });

  it('refuses through the gift schema, with the bounds', () => {
    expect(giftSchema.safeParse({ senderName: 'أحمد', message: 'كل عام وأنت بخير' }).success).toBe(
      true,
    );
    expect(giftSchema.safeParse({}).success).toBe(true);
    expect(giftSchema.safeParse({ message: 'تواصل معي 0933123456' }).success).toBe(false);
    expect(giftSchema.safeParse({ senderName: 'أ'.repeat(31) }).success).toBe(false);
    expect(giftSchema.safeParse({ message: 'ب'.repeat(140) }).success).toBe(true);
    expect(giftSchema.safeParse({ message: 'ب'.repeat(141) }).success).toBe(false);
    expect(giftSchema.parse({ senderName: '  أحمد  ' })).toEqual({ senderName: 'أحمد' });
  });
});

describe('saved player labels (rule SP1)', () => {
  it('trims and bounds the label, printable only', () => {
    expect(savedPlayerLabelSchema.parse('  حسابي ')).toBe('حسابي');
    expect(savedPlayerLabelSchema.safeParse('').success).toBe(false);
    expect(savedPlayerLabelSchema.safeParse('   ').success).toBe(false);
    expect(savedPlayerLabelSchema.safeParse('أ'.repeat(30)).success).toBe(true);
    expect(savedPlayerLabelSchema.safeParse('أ'.repeat(31)).success).toBe(false);
    expect(savedPlayerLabelSchema.safeParse('أخي‮').success).toBe(false);
    expect(savedPlayerLabelSchema.safeParse('a\tb').success).toBe(false);
  });

  it('rides on the purchase with the gift', () => {
    const order = createOrderSchema.parse({
      productId,
      quantity: 1,
      expectedUnitPriceUsdUnits: 1_000_000,
      savePlayer: { label: 'أخي' },
      gift: { senderName: 'أحمد' },
    });
    expect(order.savePlayer).toEqual({ label: 'أخي' });
    expect(order.gift).toEqual({ senderName: 'أحمد' });
    expect(
      createOrderSchema.safeParse({
        productId,
        quantity: 1,
        expectedUnitPriceUsdUnits: 1_000_000,
        savePlayer: { label: '' },
      }).success,
    ).toBe(false);
  });
});

describe('field values (rules SH3, PV3, CT2)', () => {
  it('masks a value of 6 characters or more to its last 4', () => {
    expect(maskFieldValue('51234568')).toBe('••••4568');
    expect(maskFieldValue('123456')).toBe('••••3456');
    expect(maskFieldValue('12345')).toBe('••••');
    expect(maskFieldValue('')).toBe('••••');
  });

  it('puts the trimmed values in key order', () => {
    expect(canonicalFields({ zone: ' 2 ', player_id: '51234567 ', a1: 'x' })).toEqual([
      ['a1', 'x'],
      ['player_id', '51234567'],
      ['zone', '2'],
    ]);
    expect(canonicalFields({})).toEqual([]);
  });

  it('merges cart lines by product and canonical fields, never a gift', () => {
    const line = { productId, fields: { player_id: '51234567', zone: '2' } };
    expect(cartLineKey(line)).toBe(
      cartLineKey({ productId, fields: { zone: '2 ', player_id: ' 51234567' } }),
    );
    expect(cartLineKey(line)).not.toBe(
      cartLineKey({ productId, fields: { player_id: '51234568', zone: '2' } }),
    );
    expect(cartLineKey({ ...line, gift: null })).toBe(cartLineKey(line));
    expect(cartLineKey({ ...line, gift: { message: 'مبروك' } })).toBeNull();
    expect(cartLineKey({ ...line, gift: {} })).toBeNull();
  });
});

describe('share stage (rule SH4)', () => {
  it.each([
    ['paid', 'processing'],
    ['sent_to_supplier', 'processing'],
    ['failed', 'processing'],
    ['needs_review', 'processing'],
    ['delivered', 'delivered'],
    ['partially_refunded', 'partially_delivered'],
    ['refunded', 'not_delivered'],
  ] as const)('%s is %s', (status, stage) => {
    expect(shareStage(status, 1, 2)).toEqual({ stage, deliveredQuantity: 1, quantity: 2 });
  });

  it('never shares a reservation or a cancelled order', () => {
    expect(shareStage('awaiting_balance', 0, 1)).toBeNull();
    expect(shareStage('cancelled', 0, 1)).toBeNull();
    expect([...SHAREABLE_ORDER_STATUSES].sort()).toEqual(
      ORDER_STATUSES.filter((status) => status !== 'awaiting_balance' && status !== 'cancelled')
        .slice()
        .sort(),
    );
  });
});

describe('checkout (rules CT5, M1)', () => {
  const line = {
    productId,
    quantity: 2,
    fields: { player_id: '51234567' },
    expectedUnitPriceUsdUnits: 1_250_000,
  };

  it('sums the lines’ totals', () => {
    expect(
      checkoutTotal([
        { unitPriceUsdUnits: 1_250_000, quantity: 2 },
        { unitPriceUsdUnits: 990_000, quantity: 1 },
      ]),
    ).toBe(3_490_000);
    expect(checkoutTotal([])).toBe(0);
    expect(() =>
      checkoutTotal([
        { unitPriceUsdUnits: Number.MAX_SAFE_INTEGER, quantity: 1 },
        { unitPriceUsdUnits: 1, quantity: 1 },
      ]),
    ).toThrow(RangeError);
  });

  it('takes 1 to 10 lines without the reservation choice', () => {
    expect(checkoutRequestSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(checkoutRequestSchema.safeParse({ lines: [line] }).success).toBe(true);
    expect(
      checkoutRequestSchema.safeParse({ lines: Array(CART_LINES_MAX).fill(line) }).success,
    ).toBe(true);
    expect(
      checkoutRequestSchema.safeParse({ lines: Array(CART_LINES_MAX + 1).fill(line) }).success,
    ).toBe(false);
    const parsed = checkoutRequestSchema.parse({
      lines: [{ ...line, whenBalanceShort: 'reserve' }],
    });
    expect(parsed.lines[0]).not.toHaveProperty('whenBalanceShort');
    expect(parsed.lines[0]?.confirmPlayer).toBe(false);
  });
});

describe('share links (rules RC1, SH1, SH2, AD1)', () => {
  it('defaults the receipt options to the price shown and the id masked', () => {
    expect(receiptOptionsSchema.parse({})).toEqual({ showPrice: true, playerDisplay: 'masked' });
    expect(receiptOptionsSchema.parse({ showPrice: false, playerDisplay: 'full' })).toEqual({
      showPrice: false,
      playerDisplay: 'full',
    });
    expect(receiptOptionsSchema.safeParse({ playerDisplay: 'half' }).success).toBe(false);
  });

  it('accepts 22 base64url characters as a token', () => {
    expect(shareTokenSchema.safeParse('AbCdEfGhIjKlMnOpQr_-12').success).toBe(true);
    expect(shareTokenSchema.safeParse('AbCdEfGhIjKlMnOpQr_-1').success).toBe(false);
    expect(shareTokenSchema.safeParse('AbCdEfGhIjKlMnOpQr+/12').success).toBe(false);
  });

  it('renders the og format by default', () => {
    expect(shareImageQuerySchema.parse({})).toEqual({ format: 'og' });
    expect(shareImageQuerySchema.safeParse({ format: 'banner' }).success).toBe(false);
  });

  it('asks the admin for a reason of 5 to 500 characters', () => {
    expect(revokeShareLinkSchema.safeParse({ reason: 'بلاغ احتيال' }).success).toBe(true);
    expect(revokeShareLinkSchema.safeParse({ reason: 'abc' }).success).toBe(false);
  });
});
