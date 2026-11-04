import type { StoreField } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  amountBounds,
  amountQuantity,
  amountText,
  inSection,
  recipientFieldOf,
  sameRecipient,
  shownRecipient,
  typedAmount,
} from './section';

const field = (type: StoreField['type']): StoreField => ({
  key: 'recipient',
  labelAr: 'الرقم',
  helpAr: null,
  type,
  required: true,
  minLength: type === 'digits' ? 6 : null,
  maxLength: type === 'digits' ? 16 : null,
  options: null,
});

const BILL = { minQuantity: 10, maxQuantity: 1_000, amountStep: 100, amountUnitAr: 'ل.س' };

describe('the section (CL1)', () => {
  it('holds credit and cash games only', () => {
    expect(inSection('credit')).toBe(true);
    expect(inSection('cash')).toBe(true);
    expect(inSection('none')).toBe(false);
    expect(inSection(undefined)).toBe(false);
  });

  it('takes its one field as the recipient', () => {
    const mtn = field('mtn_number');
    expect(recipientFieldOf('credit', [mtn])).toBe(mtn);
    expect(recipientFieldOf('none', [mtn])).toBeNull();
    expect(recipientFieldOf('cash', [])).toBeNull();
  });
});

describe('the recipient typed twice (RN1, RN2)', () => {
  it('matches one line typed two ways', () => {
    const syriatel = field('syriatel_number');
    expect(sameRecipient(syriatel, '0933 123 456', '+963 933123456')).toBe(true);
    expect(sameRecipient(syriatel, '٠٩٣٣١٢٣٤٥٦', '0933-123-456')).toBe(true);
    expect(sameRecipient(syriatel, '0933123456', '0933123457')).toBe(false);
    expect(sameRecipient(syriatel, '12', '12')).toBe(false);
  });

  it('compares a digits field by its digits', () => {
    const digits = field('digits');
    expect(sameRecipient(digits, '1234 5678', '12345678')).toBe(true);
    expect(sameRecipient(digits, '', '')).toBe(false);
  });

  it('shows a line grouped and anything else as typed', () => {
    expect(shownRecipient(field('mtn_number'), '+963944123456')).toBe('094 412 3456');
    expect(shownRecipient(field('digits'), '123456')).toBe('123456');
  });
});

describe('the free amount (AM1, AM6)', () => {
  it('reads Latin and Arabic-Indic digits with separators', () => {
    expect(typedAmount('7,300')).toBe(7_300);
    expect(typedAmount('٧٣٠٠')).toBe(7_300);
    expect(typedAmount('73.5')).toBeNull();
    expect(typedAmount('')).toBeNull();
  });

  it('turns an amount within the bounds and steps into units', () => {
    expect(amountQuantity(BILL, '7300')).toBe(73);
    expect(amountQuantity(BILL, '7350')).toBeNull();
    expect(amountQuantity(BILL, '900')).toBeNull();
    expect(amountQuantity(BILL, '100100')).toBeNull();
  });

  it('shows an amount, never a quantity', () => {
    expect(amountText(BILL, 73)).toBe('7,300 ل.س');
    expect(amountBounds(BILL)).toEqual({ min: '1,000', max: '100,000', step: '100', unit: 'ل.س' });
  });
});
