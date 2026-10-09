import { ORDER_STAGES } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { STAGE_TONES, stageSentence, stageText } from './stages';

describe('order stages (rule O13)', () => {
  it('names every stage with a sentence and a tone', () => {
    for (const stage of ORDER_STAGES) {
      expect(stageText(stage)).not.toContain('orders.');
      expect(stageSentence({ stage, refundReason: null })).not.toContain('orders.');
      expect(STAGE_TONES[stage]).toBeTruthy();
    }
  });

  it('says why an order was refunded, in plain words', () => {
    expect(stageSentence({ stage: 'refunded', refundReason: 'input_rejected' })).toContain(
      'بيانات الحساب مرفوضة',
    );
    expect(stageSentence({ stage: 'delayed', refundReason: null })).toBe(
      'تأخّر المورد، نتحقق منه وسنعلمك',
    );
  });
});
