import { ORDER_STAGES, ORDER_TIMELINE_STEPS } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { STAGE_TONES, stageSentence, stageText, stepText, timelineEntries } from './stages';

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

describe('timelineEntries (S09 rule LT1)', () => {
  const at = (minute: number) => `2026-10-09T10:0${minute}:00.000Z`;

  it('shows the steps ahead while the order is open', () => {
    expect(
      timelineEntries({ stage: 'awaiting_balance', timeline: [{ step: 'reserved', at: at(0) }] }),
    ).toEqual([
      { step: 'reserved', at: at(0), state: 'current' },
      { step: 'paid', at: null, state: 'upcoming' },
      { step: 'sent', at: null, state: 'upcoming' },
      { step: 'delivered', at: null, state: 'upcoming' },
    ]);
    expect(
      timelineEntries({
        stage: 'processing',
        timeline: [
          { step: 'paid', at: at(1) },
          { step: 'retrying', at: at(2) },
        ],
      }).map((entry) => `${entry.step}:${entry.state}`),
    ).toEqual(['paid:done', 'retrying:current', 'delivered:upcoming']);
  });

  it('shows only what happened once the order is finished', () => {
    expect(
      timelineEntries({
        stage: 'cancelled',
        timeline: [
          { step: 'reserved', at: at(0) },
          { step: 'cancelled', at: at(5) },
        ],
      }).map((entry) => entry.state),
    ).toEqual(['done', 'done']);
  });
});
