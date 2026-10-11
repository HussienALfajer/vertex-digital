import { describe, expect, it } from 'vitest';
import { faqOrder, moved, withItemMoved, withSectionMoved } from './faq-order';

const ARCHIVED = '2026-10-11T10:00:00.000Z';

const copy = {
  sections: [
    {
      id: 's1',
      archivedAt: null,
      items: [
        { id: 'a', archivedAt: null },
        { id: 'b', archivedAt: ARCHIVED },
        { id: 'c', archivedAt: null },
      ],
    },
    { id: 's2', archivedAt: ARCHIVED, items: [{ id: 'd', archivedAt: null }] },
    { id: 's3', archivedAt: null, items: [] },
  ],
} as never;

describe('faqOrder (S14 FQ4)', () => {
  it('lists the unarchived sections and questions only, in order', () => {
    expect(faqOrder(copy)).toEqual({
      sections: [
        { id: 's1', itemIds: ['a', 'c'] },
        { id: 's3', itemIds: [] },
      ],
    });
  });
});

describe('moved', () => {
  it('moves an item to another place', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
  });

  it('keeps the list when a place is out of range', () => {
    expect(moved(['a', 'b'], 0, 2)).toEqual(['a', 'b']);
    expect(moved(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });
});

describe('withSectionMoved and withItemMoved', () => {
  it('moves a section, or a question inside its own section', () => {
    const order = faqOrder(copy);
    expect(withSectionMoved(order, 1, 0).sections.map((section) => section.id)).toEqual([
      's3',
      's1',
    ]);
    expect(withItemMoved(order, 's1', 1, 0).sections[0]?.itemIds).toEqual(['c', 'a']);
    expect(withItemMoved(order, 's3', 0, 1).sections[1]?.itemIds).toEqual([]);
  });
});
