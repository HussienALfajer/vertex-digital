import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { RATE_STALE_AFTER_HOURS } from '@vertex-digital/contracts';
import { Button, Callout } from '@vertex-digital/ui';
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { rateBannerQuery } from './rates.queries';

/**
 * Rule FX7: on every page while the newest rate is older than 48 hours, or there is none. Nothing
 * is blocked; a failed read shows nothing.
 */
export function StaleRateBanner() {
  const { t } = useTranslation();
  const rates = useQuery(rateBannerQuery);
  const { pathname } = useLocation();
  if (!rates.data?.stale) return null;
  const current = rates.data.current;
  return (
    <Callout
      tone="warning"
      icon={<TriangleAlertIcon />}
      title={current ? t('rates.stale.title') : t('rates.stale.noneTitle')}
      description={
        current
          ? t('rates.stale.body', { hours: RATE_STALE_AFTER_HOURS })
          : t('rates.stale.noneBody')
      }
      action={
        pathname === '/rates' ? undefined : (
          <Button variant="outline" size="sm" render={<Link to="/rates" />}>
            {t('rates.stale.action')}
          </Button>
        )
      }
    />
  );
}
