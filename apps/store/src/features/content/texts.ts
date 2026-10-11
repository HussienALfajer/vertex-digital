import {
  type ActivityItem,
  activityAge,
  formatDeliveryDuration,
  type RichBlock,
  type RichInline,
} from '@vertex-digital/contracts';
import { type MessageKey, t } from '@/lib/i18n';

/*
 * Live activity in the store's words (S14 LA2, LA4, LA5): Arabic plural forms picked with
 * `Intl.PluralRules`, the catalog holding one text per form.
 */

const rules = new Intl.PluralRules('ar');

type Form = 'one' | 'two' | 'few' | 'many';

/** Arabic's forms as the catalog keeps them; `zero` and `other` read as `many` (11 ثانية، 100 ثانية). */
function form(count: number): Form {
  const rule = rules.select(count);
  return rule === 'one' || rule === 'two' || rule === 'few' ? rule : 'many';
}

/** LA5: "خلال 14 ثانية", "خلال 3 دقائق", "خلال ساعتين". */
export function durationText(seconds: number): string {
  const { unit, count } = formatDeliveryDuration(seconds);
  return t(`content.activity.duration.${unit}.${form(count)}` as MessageKey, { count });
}

/** LA4: "منذ نحو 5 دقائق" under an hour, "منذ نحو ساعة" after. */
export function ageText(deliveredAt: string, now: Date): string {
  const { unit, count } = activityAge(new Date(deliveredAt), now);
  return t(`content.activity.ago.${unit}.${form(count)}` as MessageKey, { count });
}

const damascusDate = new Intl.DateTimeFormat('ar-u-nu-latn', {
  dateStyle: 'long',
  timeZone: 'Asia/Damascus',
});

/** PG2: "آخر تحديث: 11 أكتوبر 2026", the day in Damascus whoever renders it. */
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

/** LA2: the pack, with "× 2" when the quantity is above 1. */
export function productText(item: Pick<ActivityItem, 'productNameAr' | 'quantity'>): string {
  return item.quantity > 1
    ? t('content.activity.quantity', { product: item.productNameAr, quantity: item.quantity })
    : item.productNameAr;
}
