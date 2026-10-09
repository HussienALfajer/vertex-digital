import type { DeliveryStats } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';
import { plural } from '@/lib/plural';

/*
 * The measured delivery time (S08 rule T1, S09 rule SF3): the median on a pack's chip, the 90th
 * percentile in the buy box. Durations round up: whole seconds under a minute, whole minutes
 * under an hour, then whole hours.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** "40 ثانية", "دقيقتين", "3 ساعات". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / SECOND));
  if (seconds < 60) return plural('units.seconds', seconds);
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return plural('units.minutes', minutes);
  return plural('units.hours', Math.ceil(ms / HOUR));
}

/** The pack's chip: "خلال 40 ثانية عادةً"; null without stats (no chip, rule SF3). */
export function deliveryChipText(stats: DeliveryStats | null): string | null {
  return stats ? t('catalog.delivery.median', { duration: formatDuration(stats.medianMs) }) : null;
}

/** The buy box's line: "9 من كل 10 طلبات خلال دقيقتين", or that there is not enough data yet. */
export function deliveryDetailText(stats: DeliveryStats | null): string {
  return stats
    ? t('catalog.delivery.p90', { duration: formatDuration(stats.p90Ms) })
    : t('catalog.delivery.noData');
}
