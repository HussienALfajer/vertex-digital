import type { StoreField } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { checkFields } from './fields';

const field = (overrides: Partial<StoreField>): StoreField => ({
  key: 'player_id',
  labelAr: 'معرّف اللاعب',
  helpAr: null,
  type: 'digits',
  required: true,
  minLength: 5,
  maxLength: 12,
  options: null,
  ...overrides,
});

describe('checkFields (rule BB2)', () => {
  it('answers the values the server reads', () => {
    const fields = [
      field({}),
      field({
        key: 'server',
        type: 'select',
        required: false,
        minLength: null,
        maxLength: null,
        options: [
          { value: 'asia', labelAr: 'آسيا' },
          { value: 'europe', labelAr: 'أوروبا' },
        ],
      }),
      field({ key: 'phone', type: 'phone', minLength: null, maxLength: null }),
    ];
    expect(checkFields(fields, { player_id: ' 51234567 ', phone: '0944 123 456' })).toEqual({
      ok: true,
      values: { player_id: '51234567', phone: '+963944123456' },
    });
  });

  it('says what is wrong with each field', () => {
    const fields = [
      field({}),
      field({ key: 'exact', minLength: 8, maxLength: 8 }),
      field({ key: 'name', type: 'text', minLength: null, maxLength: 20 }),
      field({ key: 'phone', type: 'phone', minLength: null, maxLength: null }),
      field({
        key: 'server',
        type: 'select',
        minLength: null,
        maxLength: null,
        options: [
          { value: 'asia', labelAr: 'آسيا' },
          { value: 'europe', labelAr: 'أوروبا' },
        ],
      }),
    ];
    const result = checkFields(fields, {
      player_id: '',
      exact: '12a',
      name: 'x'.repeat(21),
      phone: '12',
      server: 'mars',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        player_id: 'هذا الحقل مطلوب',
        exact: 'أرقام فقط، عددها 8',
        name: 'من 1 إلى 20 حرفًا',
        phone: 'رقم هاتف غير صالح. اكتبه مع رمز الدولة أو بصيغة 09',
        server: 'اختر واحدًا من الخيارات',
      },
    });
    expect(checkFields([field({ minLength: null, maxLength: null })], { player_id: 'x' })).toEqual({
      ok: false,
      errors: { player_id: 'أرقام فقط، من 1 إلى 32 خانة' },
    });
  });
});
