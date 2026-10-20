import type { MerchantApplication } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { draftOf, draftProblems, emptyDraft, inputOf, type MerchantDraft, toggled } from './form';

const TERMS = '0199f000-0000-7000-8000-0000000000aa';

const filled = (changes: Partial<MerchantDraft> = {}): MerchantDraft => ({
  ...emptyDraft('+963933123456'),
  tradeName: 'محل النور',
  activity: 'phone_shop',
  yearsInBusiness: '1_3',
  governorate: 'aleppo',
  city: 'اعزاز',
  streetAddress: 'شارع السوق',
  monthlyVolume: '500_2000',
  productInterests: ['game_topups'],
  salesChannels: ['shop_counter'],
  termsAccepted: true,
  ...changes,
});

describe('the merchant form (MA2)', () => {
  it('starts with the account phone and nothing chosen', () => {
    const draft = emptyDraft('+963933123456');
    expect(draft.whatsapp).toBe('+963933123456');
    expect(draftProblems(draft, TERMS, ['shop'])).toEqual([
      'tradeName',
      'activity',
      'yearsInBusiness',
      'governorate',
      'city',
      'streetAddress',
    ]);
  });

  it('checks each step alone, and the terms last', () => {
    const draft = filled({ termsAccepted: false, telegramUsername: 'ab' });
    expect(draftProblems(draft, TERMS, ['shop'])).toEqual([]);
    expect(draftProblems(draft, TERMS, ['contact'])).toEqual(['telegramUsername']);
    expect(draftProblems(draft, TERMS, ['proof'])).toEqual(['terms']);
    expect(draftProblems(filled(), TERMS)).toEqual([]);
  });

  it('asks the text of "other" only for "other", and links only in the shop link', () => {
    expect(draftProblems(filled({ activity: 'other' }), TERMS, ['shop'])).toEqual([
      'activityOther',
    ]);
    expect(draftProblems(filled({ city: 'www.example.com' }), TERMS, ['shop'])).toEqual(['city']);
    expect(draftProblems(filled({ shopLink: 'http://x.example' }), TERMS, ['proof'])).toEqual([
      'shopLink',
    ]);
  });

  it('sends empty optional fields as null, and "other"’s text only with it', () => {
    const input = inputOf(filled({ activityOther: 'نص قديم', telegramUsername: ' ' }), TERMS);
    expect(input).toMatchObject({
      activityOther: null,
      telegramUsername: null,
      shopLink: null,
      termsVersionId: TERMS,
    });
  });

  it('edits an application again with the terms to accept anew', () => {
    const application = {
      ...inputOf(filled({ telegramUsername: 'nour_shop' }), TERMS),
      id: TERMS,
      status: 'info_requested',
      activityOther: null,
      shopLink: null,
    } as unknown as MerchantApplication;
    expect(draftOf(application)).toMatchObject({
      telegramUsername: 'nour_shop',
      activityOther: '',
      shopLink: '',
      termsAccepted: false,
    });
  });

  it('toggles a choice', () => {
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggled(['b'], 'a', true)).toEqual(['b', 'a']);
    expect(toggled(['a'], 'a', true)).toEqual(['a']);
  });
});
