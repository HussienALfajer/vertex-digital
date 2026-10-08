import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  type AdminSwitches,
  type DepositSettings,
  STORE_SWITCHES,
  type StoreSwitch,
  type SwitchChange,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  FieldLabel,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { HistoryIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { depositSettingsQuery } from '../deposits/deposits.queries';
import { switchesQuery, switchHistoryQuery, useChangeSwitch } from './settings.queries';

type SwitchView = AdminSwitches['switches'][number];

const ALL = 'all';

/**
 * "المفاتيح" (S05, F26): the emergency stop, the deposit method pauses and registration, each
 * changed after a confirmation and a re-authentication (rules SW2, SW3), then the history.
 */
export function SwitchesPage({
  filter,
  onFilter,
}: {
  filter: StoreSwitch | undefined;
  onFilter: (filter: StoreSwitch | undefined) => void;
}) {
  const { t } = useTranslation();
  const switches = useQuery(switchesQuery);
  const settings = useQuery(depositSettingsQuery);
  const [pending, setPending] = useState<SwitchView | null>(null);
  const byName = new Map(switches.data?.switches.map((item) => [item.switch, item]));
  const row = (name: StoreSwitch) => {
    const item = byName.get(name);
    return item ? (
      <SwitchRow
        item={item}
        note={unconfiguredNote(name, settings.data)}
        onToggle={() => setPending(item)}
      />
    ) : null;
  };

  return (
    <>
      <PageHeader title={t('switches.title')} description={t('switches.subtitle')} />
      {switches.isPending && (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {switches.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, switches.error)}</FormAlert>
          <Button variant="outline" onClick={() => switches.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {switches.isSuccess && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="gap-4 lg:col-span-2">
            <div className="flex flex-col gap-1">
              <CardTitle>{t('switches.sections.emergency')}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {t('switches.sections.emergencyHelp')}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {row('purchases_stopped')}
              {row('deposits_stopped')}
            </div>
          </Card>
          <Card className="gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>{t('switches.sections.methods')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('switches.sections.methodsHelp')}</p>
            </div>
            {row('sham_cash_paused')}
            {row('usdt_trc20_paused')}
            {row('usdt_bep20_paused')}
          </Card>
          <Card className="gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>{t('switches.sections.registration')}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {t('switches.sections.registrationHelp')}
              </p>
            </div>
            {row('registration_open')}
          </Card>
        </div>
      )}
      <History filter={filter} onFilter={onFilter} />
      {pending && <ChangeDialog item={pending} onClose={() => setPending(null)} />}
    </>
  );
}

/** A method paused here that the deposit settings do not offer anyway. */
function unconfiguredNote(
  name: StoreSwitch,
  settings: DepositSettings | undefined,
): 'switches.unconfigured' | null {
  if (!settings) return null;
  const configured =
    name === 'sham_cash_paused'
      ? settings.saved && (settings.sypEnabled || settings.usdEnabled)
      : name === 'usdt_trc20_paused'
        ? settings.usdtTrc20Enabled &&
          !!settings.usdt.find((network) => network.method === 'usdt_trc20')?.address
        : name === 'usdt_bep20_paused'
          ? settings.usdtBep20Enabled &&
            !!settings.usdt.find((network) => network.method === 'usdt_bep20')?.address
          : true;
  return configured ? null : 'switches.unconfigured';
}

function SwitchRow({
  item,
  note,
  onToggle,
}: {
  item: SwitchView;
  note: 'switches.unconfigured' | null;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const id = `switch-${item.switch}`;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-base font-medium">
          {t(`switches.names.${item.switch}`)}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stateTone(item)}>{t(`switches.state.${item.switch}.${item.value}`)}</Badge>
          {item.since && item.channel && (
            <span className="text-sm text-muted-foreground">
              {t('switches.since', {
                time: formatDateTime(item.since),
                channel: t(`switches.channels.${item.channel}`),
              })}
            </span>
          )}
        </div>
        {note && <p className="text-sm text-muted-foreground">{t(note)}</p>}
      </div>
      <Switch id={id} checked={item.value} onCheckedChange={onToggle} className="mt-1" />
    </div>
  );
}

/** Danger while a stop is on, warning for a pause or open registration, neutral otherwise. */
function stateTone(item: SwitchView): 'danger' | 'warning' | 'neutral' {
  if (!item.value) return 'neutral';
  return item.switch === 'purchases_stopped' || item.switch === 'deposits_stopped'
    ? 'danger'
    : 'warning';
}

function ChangeDialog({ item, onClose }: { item: SwitchView; onClose: () => void }) {
  const { t } = useTranslation();
  const change = useChangeSwitch();
  const value = !item.value;
  const key = `switches.confirm.${item.switch}.${value}` as const;
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={t(`${key}.title`)}
      body={t(`${key}.body`)}
      action={t(`${key}.action`)}
      destructive={value && item.switch !== 'registration_open'}
      pending={change.isPending}
      onConfirm={async () => {
        await change.mutateAsync({ switch: item.switch, value });
      }}
    >
      {item.switch === 'registration_open' && value && (
        <FormAlert>{t('switches.confirm.registrationWarning')}</FormAlert>
      )}
    </ConfirmDialog>
  );
}

function History({
  filter,
  onFilter,
}: {
  filter: StoreSwitch | undefined;
  onFilter: (filter: StoreSwitch | undefined) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(switchHistoryQuery(filter));
  const changes = list.data?.pages.flatMap((page) => page.items) ?? [];
  const items = [
    { value: ALL, label: t('switches.history.all') },
    ...STORE_SWITCHES.map((name) => ({ value: name, label: t(`switches.names.${name}`) })),
  ];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="switch-history">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="switch-history" className="text-lg font-bold">
          {t('switches.history.title')}
        </h2>
        <Field className="w-full sm:w-64">
          <FieldLabel>{t('switches.history.filter')}</FieldLabel>
          <Select
            items={items}
            value={filter ?? ALL}
            onValueChange={(next) =>
              onFilter(next && next !== ALL ? (next as StoreSwitch) : undefined)
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {list.isPending && <Skeleton className="h-48 w-full" aria-hidden="true" />}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess &&
        (changes.length === 0 ? (
          <EmptyState icon={<HistoryIcon />} title={t('switches.history.empty')} />
        ) : (
          <HistoryTable changes={changes} />
        ))}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
    </section>
  );
}

function HistoryTable({ changes }: { changes: SwitchChange[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('switches.history.time')}</TableHead>
          <TableHead>{t('switches.history.switch')}</TableHead>
          <TableHead>{t('switches.history.change')}</TableHead>
          <TableHead>{t('switches.history.channel')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {changes.map((change) => (
          <TableRow key={change.id}>
            <TableCell className="whitespace-nowrap">{formatDateTime(change.createdAt)}</TableCell>
            <TableCell>{t(`switches.names.${change.switch}`)}</TableCell>
            <TableCell>
              {t('switches.history.fromTo', {
                from: t(`switches.state.${change.switch}.${!change.value}`),
                to: t(`switches.state.${change.switch}.${change.value}`),
              })}
            </TableCell>
            <TableCell>{t(`switches.channels.${change.channel}`)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
