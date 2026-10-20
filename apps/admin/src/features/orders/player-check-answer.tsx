import type { PlayerCheck } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';

/** An admin check's answer (rule AP8): the name, and S19 PC9's region or PC3's mismatch. */
export function PlayerCheckAnswer({ check }: { check: PlayerCheck }) {
  const { t } = useTranslation();
  switch (check.result) {
    case 'valid':
      return (
        <Badge tone="success" className="h-auto min-h-6 whitespace-normal">
          {check.playerName
            ? t('orders.buy.checkValid', { name: check.playerName })
            : t('orders.buy.checkValidNoName')}
          {check.region && ` · ${t('orders.buy.checkRegion', { region: check.region })}`}
        </Badge>
      );
    case 'region_mismatch':
      return (
        <Badge tone="danger" className="h-auto min-h-6 whitespace-normal">
          {t('orders.buy.checkRegionMismatch', { region: check.region })}
          {check.playerName && ` · ${check.playerName}`}
        </Badge>
      );
    case 'invalid':
      return <Badge tone="danger">{t('orders.buy.checkInvalid')}</Badge>;
    case 'unavailable':
      return <Badge tone="warning">{t('orders.buy.checkUnavailable')}</Badge>;
    default:
      return <Badge tone="neutral">{t('orders.buy.checkNotSupported')}</Badge>;
  }
}
