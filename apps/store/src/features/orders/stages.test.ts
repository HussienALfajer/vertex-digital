import { ORDER_STAGES, ORDER_TIMELINE_STEPS } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { STAGE_TONES, stageSentence, stageText, stepText } from './stages';

describe('order stages (rule O13)', () => {
  it('names every stage with a sentence and a tone', () => {
    for (const stage of ORDER_STAGES) {
      expect(stageText(stage)).not.toContain('orders.');
      expect(stageSentence({ stage, refundReason: null })).not.toContain('orders.');
      expect(STAGE_TONES[stage]).toBeTruthy();
    }
    for (const step of ORDER_TIMELINE_STEPS) expect(stepText(step)).not.toContain('orders.');
  });

  it('says why a reservation was cancelled (S09 rule RS9)', () => {
    expect(stageSentence({ stage: 'cancelled', refundReason: null, cancelReason: 'expired' })).toBe(
      'انتهت مدة الحجز (24 ساعة)',
    );
    expect(stageSentence({ stage: 'cancelled', refundReason: null })).toBe('أُلغي هذا الطلب');
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
