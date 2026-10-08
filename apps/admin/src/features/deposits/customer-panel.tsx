import { Link } from '@tanstack/react-router';
import { type AdminDeposit, formatUsd } from '@vertex-digital/contracts';
import { Badge, Button, Card, CardTitle } from '@vertex-digital/ui';
import { WalletIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatDateTime, formatSince, ltr } from '../../lib/format';
import { depositAmount, STATUS_TONES } from './deposit-labels';
import { Fact } from './fact';

/**
 * Who sent the deposit (A10): account age, new or established (rule SC3), credited deposits, the
 * balance, a shared-phone note, and the last deposits with their codes (edge case 16).
 */
export function CustomerPanel({ deposit }: { deposit: AdminDeposit }) {
  const { t } = useTranslation();
  const { customer } = deposit;
  const sharedPhone = deposit.flags.some((flag) => flag.code === 'shared_phone');
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            {customer.name}
            {customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
          </CardTitle>
          <span dir="ltr" className="text-end text-sm text-muted-foreground">
            {customer.email}
          </span>
          <span dir="ltr" className="text-end text-sm text-muted-foreground">
            {customer.phone}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/wallets/$customerId" params={{ customerId: customer.id }} />}
        >
          <WalletIcon />
          {t('deposits.customer.wallet')}
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Fact label={t('deposits.customer.since')}>
          <span title={formatDate(customer.createdAt)}>{formatSince(customer.createdAt)}</span>
        </Fact>
        <Fact label={t('deposits.customer.tier')}>
          <Badge tone={customer.established ? 'success' : 'warning'}>
            {customer.established ? t('deposits.customer.established') : t('deposits.customer.new')}
          </Badge>
        </Fact>
        <Fact label={t('deposits.customer.credited')}>
          {t('deposits.customer.creditedValue', {
            deposits: customer.creditedCount,
            total: ltr(formatUsd(customer.creditedTotalUsdUnits)),
          })}
        </Fact>
        <Fact label={t('deposits.customer.balance')}>
          <bdi dir="ltr" className="tabular-nums">
            {formatUsd(customer.balanceUnits)}
          </bdi>
        </Fact>
      </dl>
      {sharedPhone && (
        <p className="text-sm text-status-warning-foreground">
          {t('deposits.customer.sharedPhone')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t('deposits.customer.recent')}
        </h3>
        {customer.recentDeposits.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('deposits.customer.noRecent')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {customer.recentDeposits.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link
                  to="/deposits/$id"
                  params={{ id: item.id }}
                  className="rounded-sm font-medium underline-offset-4 hover:underline"
                >
                  <bdi dir="ltr">{item.referenceCode}</bdi>
                </Link>
                <span className="tabular-nums">
                  {depositAmount(t, item.currency, item.declaredAmountUnits)}
                </span>
                <span className="text-muted-foreground">{formatDateTime(item.createdAt)}</span>
                <Badge tone={STATUS_TONES[item.status]}>
                  {t(`deposits.statuses.${item.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
