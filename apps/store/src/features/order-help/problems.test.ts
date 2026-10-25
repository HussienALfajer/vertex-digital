import { describe, expect, it } from 'vitest';
import { problemLabel, problemTicket } from './problems';

describe('order problem tickets (S22 OP2, OP5)', () => {
  it('names a late order by where it stands', () => {
    expect(problemLabel('not_arrived', 'sent_to_supplier')).toBe('تأخر الطلب');
    expect(problemLabel('not_arrived', 'delivered')).toBe('لم يصل الشحن');
    expect(problemLabel('code_used', 'delivered')).toBe('الكود مستخدم مسبقاً');
  });

  it('writes the subject with the order number and the body from the sentence and details', () => {
    expect(problemTicket('not_arrived', 'paid', 'VO-7KQ2MX', '  ')).toEqual({
      subject: 'تأخر الطلب · VO-7KQ2MX',
      body: 'لم يصل الطلب بعد.',
    });
    expect(problemTicket('other', 'delivered', 'VO-7KQ2MX', 'سطر\r\nثانٍ ').body).toBe(
      'لدي مشكلة في هذا الطلب.\n\nسطر\nثانٍ',
    );
  });
});
