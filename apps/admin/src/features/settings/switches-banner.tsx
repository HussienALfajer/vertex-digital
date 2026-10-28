import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import {
  type StoreSwitch,
  SUPPLIER_PAUSE_SWITCHES,
  type SupplierCode,
} from '@vertex-digital/contracts';
import { Button, Callout } from '@vertex-digital/ui';
import { OctagonAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatSince } from '../../lib/format';
import { switchesBannerQuery } from './settings.queries';

/** The supplier each pause switch stops (S07 SP3): those are switched on the supplier's page. */
const SUPPLIER_OF = new Map(
  Object.entries(SUPPLIER_PAUSE_SWITCHES).map(([code, name]) => [name, code as SupplierCode]),
);

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
  // A supplier's pause is no deposit method's, and its switch is on the supplier's page, not on
  // the switches page (audit A09-41).
  const suppliers = active.flatMap((item) => SUPPLIER_OF.get(item.switch as StoreSwitch) ?? []);
  const onlySuppliers = suppliers.length === active.length;
  const title = stopped
    ? 'switches.banner.stoppedTitle'
    : onlySuppliers
      ? 'switches.banner.supplierPausedTitle'
      : suppliers.length > 0
        ? 'switches.banner.mixedPausedTitle'
        : 'switches.banner.pausedTitle';
  return (
    <Callout
      tone={stopped ? 'danger' : 'warning'}
      icon={<OctagonAlertIcon />}
      title={t(title)}
      description={active
        .map((item) =>
          t('switches.banner.item', {
            name: t(`switches.names.${item.switch}`),
            since: item.since ? formatSince(item.since) : '',
          }),
        )
        .join('، ')}
      action={
        onlySuppliers ? (
          suppliers.length === 1 && suppliers[0] ? (
            pathname === `/suppliers/${suppliers[0]}` ? undefined : (
              <Button
                variant="outline"
                size="sm"
                render={<Link to="/suppliers/$code" params={{ code: suppliers[0] }} />}
              >
                {t('switches.banner.supplierAction')}
              </Button>
            )
          ) : pathname === '/suppliers' ? undefined : (
            <Button variant="outline" size="sm" render={<Link to="/suppliers" />}>
              {t('switches.banner.suppliersAction')}
            </Button>
          )
        ) : pathname === '/settings/switches' ? undefined : (
          <Button variant="outline" size="sm" render={<Link to="/settings/switches" />}>
            {t('switches.banner.action')}
          </Button>
        )
      }
    />
  );
}
