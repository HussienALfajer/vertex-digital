import type { FaqOrder, FaqWorkingCopy } from '@vertex-digital/contracts';

/** Rule FQ4: every unarchived section and, per section, its unarchived questions, in order. */
export function faqOrder(copy: Pick<FaqWorkingCopy, 'sections'>): FaqOrder {
  return {
    sections: copy.sections
      .filter((section) => !section.archivedAt)
      .map((section) => ({
        id: section.id,
        itemIds: section.items.filter((item) => !item.archivedAt).map((item) => item.id),
      })),
  };
}

/** `ids` with the one at `from` moved to `to`; the same list when either is out of range. */
export function moved<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1) as [T];
  next.splice(to, 0, item);
  return next;
}

/** The order with a section moved from one place to another. */
export function withSectionMoved(order: FaqOrder, from: number, to: number): FaqOrder {
  return { sections: moved(order.sections, from, to) };
}

/** The order with a question moved inside its section. */
export function withItemMoved(
  order: FaqOrder,
  sectionId: string,
  from: number,
  to: number,
): FaqOrder {
  return {
    sections: order.sections.map((section) =>
      section.id === sectionId
        ? { ...section, itemIds: moved(section.itemIds, from, to) }
        : section,
    ),
  };
}
