import { describe, expect, it } from 'vitest';
import {
  attemptSignature,
  bodyLength,
  bodyValid,
  draftProblems,
  imageProblem,
  messageBody,
  type TicketDraft,
} from './form';

const MB = 1024 * 1024;

const draft = (changes: Partial<TicketDraft> = {}): TicketDraft => ({
  category: 'other',
  orderId: null,
  depositId: null,
  subject: 'سؤال عن الشحن',
  body: 'متى يصل الشحن؟',
  ...changes,
});

describe('imageProblem (TK11)', () => {
  it('takes JPEG, PNG and WebP up to 5 MB', () => {
    expect(imageProblem({ type: 'image/png', size: 5 * MB })).toBeNull();
    expect(imageProblem({ type: 'image/webp', size: 1 })).toBeNull();
    expect(imageProblem({ type: 'image/jpeg', size: 1 })).toBeNull();
  });

  it('refuses other types, then larger files', () => {
    expect(imageProblem({ type: 'image/heic', size: 1 })).toBe('invalid');
    expect(imageProblem({ type: 'application/pdf', size: 10 * MB })).toBe('invalid');
    expect(imageProblem({ type: 'image/png', size: 5 * MB + 1 })).toBe('tooLarge');
  });
});

describe('messageBody (TK7)', () => {
  it('fills an empty text only when images go with it', () => {
    expect(messageBody('  ', 1, 'صورة مرفقة')).toBe('صورة مرفقة');
    expect(messageBody('', 0, 'صورة مرفقة')).toBe('');
    expect(messageBody('مرحباً', 2, 'صورة مرفقة')).toBe('مرحباً');
  });
});

describe('bodyValid and bodyLength', () => {
  it('needs text or an image, at most 2000 characters', () => {
    expect(bodyValid('', 0)).toBe(false);
    expect(bodyValid('', 1)).toBe(true);
    expect(bodyValid('a'.repeat(2000), 0)).toBe(true);
    expect(bodyValid('a'.repeat(2001), 0)).toBe(false);
  });

  it('keeps new lines and refuses other control characters', () => {
    expect(bodyValid('سطر\nسطر', 0)).toBe(true);
    expect(bodyValid('a\u0007b', 0)).toBe(false);
  });

  it('counts as the API does', () => {
    expect(bodyLength('  ab\r\ncd  ')).toBe(5);
  });
});

describe('draftProblems (TK1)', () => {
  it('passes a complete draft', () => {
    expect(draftProblems(draft(), 0)).toEqual([]);
  });

  it('asks for the type, then the link of an order or deposit ticket', () => {
    expect(draftProblems(draft({ category: null }), 0)).toEqual(['category']);
    expect(draftProblems(draft({ category: 'order' }), 0)).toEqual(['order']);
    expect(draftProblems(draft({ category: 'deposit' }), 0)).toEqual(['deposit']);
    expect(draftProblems(draft({ category: 'deposit', depositId: 'd' }), 0)).toEqual([]);
  });

  it('checks the subject and the message', () => {
    expect(draftProblems(draft({ subject: 'ab', body: '' }), 0)).toEqual(['subject', 'body']);
    expect(draftProblems(draft({ subject: 'سطر\nآخر' }), 0)).toEqual(['subject']);
    expect(draftProblems(draft({ body: '' }), 1)).toEqual([]);
  });
});

describe('attemptSignature', () => {
  const file = { name: 'a.png', size: 10, lastModified: 1 };

  it('is the same for the same fields and files', () => {
    expect(attemptSignature({ body: 'x' }, [file])).toBe(attemptSignature({ body: 'x' }, [file]));
  });

  it('changes with a field or a file', () => {
    const first = attemptSignature({ body: 'x' }, [file]);
    expect(attemptSignature({ body: 'y' }, [file])).not.toBe(first);
    expect(attemptSignature({ body: 'x' }, [])).not.toBe(first);
  });
});
