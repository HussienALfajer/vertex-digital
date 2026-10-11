import { useQuery } from '@tanstack/react-query';
import { type ActivityItem, activityAge, formatDeliveryDuration } from '@vertex-digital/contracts';
import {
  ActivityFeed,
  type ActivityFeedItem,
  Button,
  Card,
  Skeleton,
  Switch,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { activityQuery, settingsQuery, useSetLiveActivity } from './content.queries';
import { StorePreview } from './content-parts';

/** One delivery in the store's words (LA2, LA4, LA5); the panel's preview links nowhere. */
export function activityFeedItem(t: TFunction, item: ActivityItem, now: Date): ActivityFeedItem {
  const duration = formatDeliveryDuration(item.durationSeconds);
  const age = activityAge(new Date(item.deliveredAt), now);
  return {
    key: `${item.deliveredAt}-${item.gameSlug}-${item.productNameAr}-${item.durationSeconds}`,
    game: item.gameNameAr,
    product:
      item.quantity > 1
        ? t('content.activity.quantity', { product: item.productNameAr, quantity: item.quantity })
        : item.productNameAr,
    duration: t(`content.activity.duration.${duration.unit}`, { count: duration.count }),
    time: t(`content.activity.ago.${age.unit}`, { count: age.count }),
  };
}

/**
 * "النشاط الحي" (S14 LA3, LA6): the switch, the qualifying count against the minimum, and the
 * store-wide card exactly as the store renders it (or why nothing shows), with what is never shown.
 */
export function ActivityPage() {
  const { t } = useTranslation();
  const switchId = useId();
  const settings = useQuery(settingsQuery);
  const activity = useQuery(activityQuery);
  const set = useSetLiveActivity();
  const [failure, setFailure] = useState<string | null>(null);

  if (settings.isPending || activity.isPending) {
    return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  }
  if (settings.isError || activity.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, settings.error ?? activity.error)}</FormAlert>
        <Button
          variant="outline"
          onClick={() => {
            void settings.refetch();
            void activity.refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const preview = activity.data;
  const enabled = settings.data.liveActivityEnabled;
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-3 p-4">
        <label
          htmlFor={switchId}
          className="flex cursor-pointer items-center justify-between gap-4"
        >
          <span className="font-medium">{t('content.activity.switch')}</span>
          <Switch
            id={switchId}
            checked={enabled}
            disabled={set.isPending}
            onCheckedChange={async (value) => {
              setFailure(null);
              try {
                await set.mutateAsync(value);
              } catch (error) {
                setFailure(errorMessage(t, error));
              }
            }}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          {enabled ? t('content.activity.on') : t('content.activity.off')}
        </p>
        {failure && <FormAlert>{failure}</FormAlert>}
      </Card>
      <p data-testid="activity-count">
        {t('content.activity.count', {
          count: preview.qualifyingLast24h,
          minimum: preview.minimum,
        })}
      </p>
      {preview.visible ? (
        <StorePreview>
          <div className="p-4">
            <ActivityFeed
              title={t('content.activity.title')}
              moreLabel={t('content.activity.more')}
              items={preview.items.map((item) => activityFeedItem(t, item, now))}
            />
          </div>
        </StorePreview>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-muted-foreground">
          {t('content.activity.belowMinimum', { minimum: preview.minimum })}
        </p>
      )}
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('content.activity.neverTitle')}</p>
        <p>{t('content.activity.never')}</p>
      </div>
    </div>
  );
}
