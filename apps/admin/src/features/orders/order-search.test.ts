import { describe, expect, it } from 'vitest';
import { listQuery, parseOrderSearch, tabOf, withFilter } from './order-search';

const id = '0199c3a4-0000-7000-8000-000000000001';

describe('parseOrderSearch', () => {
  it('keeps the valid tab, filters and page', () => {
    expect(
      parseOrderSearch({
        tab: 'review',
        q: ' VO-ABC234 ',
        productId: id,
        supplier: 'fake',
        test: 'true',
        from: '2026-10-01',
        to: '2026-10-09',
        page: '3',
      }),
    ).toEqual({
      tab: 'review',
      q: 'VO-ABC234',
      productId: id,
      supplier: 'fake',
      test: 'true',
      from: '2026-10-01',
      to: '2026-10-09',
      page: 3,
    });
  });

  it('drops anything invalid', () => {
    expect(
      parseOrderSearch({
        tab: 'all',
        q: '',
        productId: 'x',
        supplier: 'acme',
        test: 'yes',
        from: '2026-13-45',
        to: 'today',
        page: '1',
      }),
    ).toEqual({});
    expect(parseOrderSearch({ tab: 'nope', page: 'two', q: 'x'.repeat(101) })).toEqual({});
  });
});

describe('withFilter and listQuery', () => {
  it('starts again at the first page and drops cleared filters', () => {
    expect(
      withFilter({ tab: 'manual', page: 4, supplier: 'fake' }, { supplier: undefined }),
    ).toEqual({ tab: 'manual' });
    expect(withFilter({ tab: 'manual' }, { tab: 'all' })).toEqual({});
  });

  it('asks for whole days and the first page by default', () => {
    const query = listQuery({ from: '2026-10-01', to: '2026-10-01' });
    expect(tabOf({})).toBe('all');
    expect(query.tab).toBe('all');
    expect(query.page).toBe(1);
    expect(new Date(query.to as string).getTime() - new Date(query.from as string).getTime()).toBe(
      86_399_999,
    );
  });
});
