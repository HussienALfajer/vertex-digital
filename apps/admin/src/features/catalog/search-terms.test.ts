import { describe, expect, it } from 'vitest';
import { addSearchTerm } from './search-terms';

describe('addSearchTerm (rule AD1)', () => {
  it('adds the normalized term', () => {
    expect(addSearchTerm([], '  PUBG  ')).toEqual({ term: 'pubg', refusal: null });
    expect(addSearchTerm(['pubg'], 'بَبجي')).toEqual({ term: 'ببجي', refusal: null });
  });

  it('refuses an empty, long, duplicate term, or a 21st one', () => {
    expect(addSearchTerm([], ' ... ').refusal).toBe('empty');
    expect(addSearchTerm([], 'a'.repeat(41)).refusal).toBe('tooLong');
    expect(addSearchTerm(['ابجي'], 'أبجي').refusal).toBe('duplicate');
    const full = Array.from({ length: 20 }, (_, index) => `term${index}`);
    expect(addSearchTerm(full, 'new').refusal).toBe('full');
  });
});
