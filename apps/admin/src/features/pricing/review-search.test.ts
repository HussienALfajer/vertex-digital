import { describe, expect, it } from 'vitest';
import { parseReviewSearch } from './review-search';

describe('parseReviewSearch', () => {
  it('keeps a status other than open, a supplier and a page', () => {
    expect(parseReviewSearch({ status: 'accepted', supplier: 'fake', page: '2' })).toEqual({
      status: 'accepted',
      supplier: 'fake',
      page: 2,
    });
  });

  it('drops open, the first page and anything invalid', () => {
    expect(parseReviewSearch({ status: 'open', supplier: 'acme', page: '1' })).toEqual({});
    expect(parseReviewSearch({ status: 'closed', page: 'two' })).toEqual({});
  });
});
