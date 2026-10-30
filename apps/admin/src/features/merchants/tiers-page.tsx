import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatUsd,
  type LevelTier,
  type MerchantTierView,
  type TierSettings,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
} from '@vertex-digital/ui';
import {
  ArchiveIcon,
  CircleAlertIcon,
  GaugeIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { merchantTiersQuery, useSetTierLevel } from './merchants.queries';
import { TierChip } from './tier-chip';
import { TierLevelDialog, TierSettingsDialog } from './tier-dialogs';
import { TierPreviewSheet } from './tier-preview-sheet';

/** The privileges a card lists as marks when on (TS2). */
const FLAGS = [
  'depositPriority',
  'supportPriority',
  'directContact',
  'earlyAccess',
  'fastAlerts',
  'receiptWelcome',
  'receiptLargeLogo',
] as const satisfies readonly (keyof TierSettings)[];

/**
 * "فئات التجّار" (S23 AD2, AD3): the four tiers as cards, Bronze on the wholesale list, Silver to
 * Diamond with their threshold, chained list and merchants (earned and granted); each tier's
 * privileges (TS2). Thresholds, lists and privileges are edited in dialogs, each re-authenticated,
 * and the threshold preview opens beside the page. A level whose list does not inherit from the
 * tier below's shows the gap (edge case 3).
 */
export function MerchantTiersPage() {
  const { t } = useTranslation();
  const tiers = useQuery(merchantTiersQuery);
  const [editingLevel, setEditingLevel] = useState<MerchantTierView | null>(null);
  const [editingSettings, setEditingSettings] = useState<MerchantTierView | null>(null);
  const [archiving, setArchiving] = useState<MerchantTierView | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const items = tiers.data?.items ?? [];

  return (
    <>
      <PageHeader
        title={t('merchants.tiers.title')}
        description={t('merchants.tiers.subtitle')}
        actions={
          <Button variant="outline" disabled={!tiers.isSuccess} onClick={() => setPreviewing(true)}>
            <GaugeIcon />
            {t('merchants.tiers.preview.open')}
          </Button>
        }
      />
      {tiers.isPending && (
        <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
          {[0, 1, 2, 3].map((card) => (
            <Skeleton key={card} className="h-80 w-full" />
          ))}
        </div>
      )}
      {tiers.isError && !tiers.data && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, tiers.error)}
          action={
            <Button variant="outline" onClick={() => tiers.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {items.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((view) => (
            <TierCard
              key={view.tier}
              view={view}
              onEditLevel={() => setEditingLevel(view)}
              onEditSettings={() => setEditingSettings(view)}
              onArchive={() => setArchiving(view)}
            />
          ))}
        </div>
      )}
      <Dialog open={editingLevel !== null} onOpenChange={(open) => !open && setEditingLevel(null)}>
        {editingLevel && editingLevel.tier !== 'bronze' && (
          <TierLevelDialog
            tier={editingLevel.tier}
            tiers={items}
            onDone={() => setEditingLevel(null)}
          />
        )}
      </Dialog>
      <Dialog
        open={editingSettings !== null}
        onOpenChange={(open) => !open && setEditingSettings(null)}
      >
        {editingSettings && tiers.data && (
          <TierSettingsDialog
            view={editingSettings}
            minDepositUsdUnits={tiers.data.minDepositUsdUnits}
            onDone={() => setEditingSettings(null)}
          />
        )}
      </Dialog>
      {archiving && archiving.tier !== 'bronze' && (
        <ArchiveLevelDialog
          tier={archiving.tier}
          merchants={archiving.merchants.earned + archiving.merchants.granted}
          onClose={() => setArchiving(null)}
        />
      )}
      {tiers.data && (
        <TierPreviewSheet open={previewing} tiers={items} onClose={() => setPreviewing(false)} />
      )}
    </>
  );
}

function TierCard({
  view,
  onEditLevel,
  onEditSettings,
  onArchive,
}: {
  view: MerchantTierView;
  onEditLevel: () => void;
  onEditSettings: () => void;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  const { tier, level, priceList, settings, merchants } = view;
  const name = t(`merchants.tierNames.${tier}`);
  const gap = level !== null && level.priceList.parentListId !== level.expectedParentListId;
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <TierChip tier={tier} />
        </CardTitle>
        <span className="text-sm text-muted-foreground tabular-nums">
          {t('merchants.tiers.merchants', { earned: merchants.earned, granted: merchants.granted })}
        </span>
      </div>
      {tier !== 'bronze' && level === null ? (
        <p className="text-sm text-muted-foreground">{t('merchants.tiers.off')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4">
          <Fact label={t('merchants.tiers.threshold')}>
            {level ? (
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(level.monthlyThresholdUsdUnits)}
              </bdi>
            ) : (
              t('merchants.tiers.everyMerchant')
            )}
          </Fact>
          <Fact label={t('merchants.tiers.list')}>
            {priceList ? (
              <Link
                to="/pricing/lists/$id"
                params={{ id: priceList.id }}
                className="underline-offset-4 hover:underline"
              >
                {priceList.name}
              </Link>
            ) : (
              '—'
            )}
          </Fact>
        </dl>
      )}
      {gap && (
        <Callout
          tone="warning"
          icon={<CircleAlertIcon />}
          title={t('merchants.tiers.gap', { tier: name })}
        />
      )}
      {level?.priceList.archived && (
        <Callout
          tone="warning"
          icon={<CircleAlertIcon />}
          title={t('merchants.tiers.listArchived')}
        />
      )}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-sm font-medium">{t('merchants.tiers.privileges')}</h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Fact label={t('merchants.tiers.deposits')}>
            <bdi dir="ltr" className="tabular-nums">
              {formatUsd(settings.perDepositUsdUnits)} / {formatUsd(settings.dailyDepositUsdUnits)}
            </bdi>
          </Fact>
          <Fact label={t('merchants.tiers.checks')}>
            <span className="tabular-nums">
              {t('merchants.tiers.checksValue', {
                hour: settings.playerChecksPerHour,
                day: settings.playerChecksPerDay,
              })}
            </span>
          </Fact>
          <Fact label={t('merchants.tiers.quantities')}>
            <span className="tabular-nums">
              {t('merchants.tiers.quantitiesValue', {
                lines: settings.bulkLinesMax,
                units: settings.orderUnitsMax,
              })}
            </span>
          </Fact>
          <Fact label={t('merchants.tiers.reply')}>
            {settings.supportReplyMinutes === null
              ? t('merchants.tiers.noPromise')
              : t('merchants.tiers.replyValue', { minutes: settings.supportReplyMinutes })}
          </Fact>
        </dl>
        <ul className="flex flex-wrap gap-1" aria-label={t('merchants.tiers.flags')}>
          {FLAGS.filter((flag) => settings[flag]).map((flag) => (
            <li key={flag}>
              <Badge tone="success">{t(`merchants.tiers.settings.fields.${flag}`)}</Badge>
            </li>
          ))}
        </ul>
        <span className="text-xs text-muted-foreground">
          {t('merchants.tiers.updatedAt', { date: formatDate(settings.updatedAt) })}
        </span>
      </div>
      <fieldset aria-label={name} className="mt-auto flex flex-wrap gap-2">
        {tier !== 'bronze' && (
          <Button variant="outline" size="sm" onClick={onEditLevel}>
            {level ? <PencilIcon /> : <PlusIcon />}
            {level ? t('merchants.tiers.editLevel') : t('merchants.tiers.addLevel')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onEditSettings}>
          <SlidersHorizontalIcon />
          {t('merchants.tiers.editSettings')}
        </Button>
        {level && (
          <Button variant="ghost" size="sm" onClick={onArchive}>
            <ArchiveIcon />
            {t('merchants.tiers.archive')}
          </Button>
        )}
      </fieldset>
    </Card>
  );
}

/** TS1, MG7: stops a tier; its merchants fall and its open grants end. */
function ArchiveLevelDialog({
  tier,
  merchants,
  onClose,
}: {
  tier: LevelTier;
  merchants: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const archive = useSetTierLevel(tier);
  const name = t(`merchants.tierNames.${tier}`);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={t('merchants.tiers.archiveTitle', { tier: name })}
      body={t('merchants.tiers.archiveBody', { count: merchants })}
      action={t('merchants.tiers.archive')}
      destructive
      pending={archive.isPending}
      onConfirm={async () => {
        await archive.mutateAsync({ level: null });
      }}
    />
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
