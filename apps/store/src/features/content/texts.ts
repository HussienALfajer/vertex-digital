import type { RichBlock, RichInline } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/* The content pages in the store's words (S14 PG2). */

const damascusDate = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  dateStyle: 'long',
  timeZone: 'Asia/Damascus',
});

/** PG2: "آخر تحديث: 11 تشرين الأول 2026", the day in Damascus whoever renders it. */
export function updatedText(iso: string): string {
  return t('content.pages.updated', { date: damascusDate.format(new Date(iso)) });
}

/** A page's meta description: the text of its first paragraph, within 160 characters. */
export function pageDescription(blocks: RichBlock[]): string | undefined {
  const paragraph = blocks.find((block) => block.type === 'paragraph');
  if (!paragraph) return undefined;
  const text = plainText(paragraph.children).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text || undefined;
}

function plainText(nodes: RichInline[]): string {
  return nodes
    .map((node) =>
      node.type === 'text' ? node.value : node.type === 'break' ? ' ' : plainText(node.children),
    )
    .join('');
}
