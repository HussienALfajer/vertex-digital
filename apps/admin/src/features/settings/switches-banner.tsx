import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { Button, Callout } from '@vertex-digital/ui';
import { OctagonAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatSince } from '../../lib/format';
import { switchesBannerQuery } from './settings.queries';

/**
 * Rule SW10: on every page while an emergency stop or a method pause is on, naming each with
 * since when. Closed registration is the pre-pilot normal: no banner. A failed read shows nothing.
 */
export function SwitchesBanner() {
  const { t } = useTranslation();
  const switches = useQuery(switchesBannerQuery);
  const { pathname } = useLocation();
  const active = (switches.data?.switches ?? []).filter(
    (item) => item.switch !== 'registration_open' && item.value,
  );
  if (active.length === 0) return null;
  const stopped = active.some(
    (item) => item.switch === 'purchases_stopped' || item.switch === 'deposits_stopped',
  );
  return (
    <Callout
      tone={stopped ? 'danger' : 'warning'}
      icon={<OctagonAlertIcon />}
      title={t(stopped ? 'switches.banner.stoppedTitle' : 'switches.banner.pausedTitle')}
      description={active
        .map((item) =>
          t('switches.banner.item', {
            name: t(`switches.names.${item.switch}`),
            since: item.since ? formatSince(item.since) : '',
          }),
        )
        .join('، ')}
      action={
        pathname === '/settings/switches' ? undefined : (
          <Button variant="outline" size="sm" render={<Link to="/settings/switches" />}>
            {t('switches.banner.action')}
          </Button>
        )
      }
    />
  );
}
