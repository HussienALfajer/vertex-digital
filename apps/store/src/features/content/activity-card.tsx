import { ActivityFeed } from '@vertex-digital/ui/components/activity-feed';
import { t } from '@/lib/i18n';
import { activityFeed } from './data';
import { ageText, durationText, productText } from './texts';

/**
 * "آخر التسليمات" (S14 LA2–LA7): the store-wide feed on the home page, or one game's under its
 * packs. The API answers no items below the minimum or while switched off, and then nothing is
 * rendered at all (LA3). Server-rendered, no client JavaScript.
 */
export async function ActivityCard({ game }: { game?: string }) {
  const items = await activityFeed(game);
  if (items.length === 0) return null;
  const now = new Date();
  return (
    <ActivityFeed
      title={t('content.activity.title')}
      moreLabel={t('content.activity.more')}
      items={items.map((item, index) => ({
        key: `${index}-${item.deliveredAt}`,
        href: `/games/${item.gameSlug}`,
        game: item.gameNameAr,
        product: productText(item),
        duration: durationText(item.durationSeconds),
        time: ageText(item.deliveredAt, now),
      }))}
    />
  );
}
