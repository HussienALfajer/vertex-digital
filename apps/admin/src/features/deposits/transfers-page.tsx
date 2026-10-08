import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminUsdtTransfer,
  floorToWholeCents,
  formatAmountInput,
  USDT_METHODS,
  type UsdtMethod,
  type UsdtTransferState,
} from '@vertex-digital/contracts';
import {
  Badge,
  type BadgeProps,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from '@vertex-digital/ui';
import { ArrowRightIcon, InboxIcon, NotebookPenIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { AdjustDialog } from '../wallet/adjust-dialog';
import { walletQuery, walletSearchQuery } from '../wallet/wallet.queries';
import { usdtTransferListQuery } from './deposits.queries';
import type { TransferSearch } from './transfer-search';
import { CandidateList, ExplorerLink, usdtText } from './usdt-panels';

const STATE_TONES: Record<UsdtTransferState, NonNullable<BadgeProps['tone']>> = {
  credited: 'success',
  bound: 'info',
  unmatched: 'warning',
};

/** A TXID, its ends kept, the whole in the title: a hash, never compared by eye to a claim. */
const short = (text: string) => `${text.slice(0, 6)}…${text.slice(-6)}`;

/**
 * "تحويلات USDT" (S04 rule U13): every official USDT transfer the store's addresses received,
 * unmatched by default, newest first. An unmatched one shows its candidate deposits and opens the
 * S02 manual deposit, prefilled with the network, the TXID and the amount in whole cents.
 */
export function TransfersPage({
  search,
  onSearch,
}: {
  search: TransferSearch;
  onSearch: (search: TransferSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(
    usdtTransferListQuery({ method: search.method, state: search.state ?? 'unmatched' }),
  );
  const transfers = list.data?.pages.flatMap((page) => page.items) ?? [];
  const [recording, setRecording] = useState<AdminUsdtTransfer | null>(null);
  const networks = [
    { value: 'all', label: t('deposits.transfers.allNetworks') },
    ...USDT_METHODS.map((item) => ({ value: item, label: t(`wallets.methods.${item}`) })),
  ];

  return (
    <>
      <Button variant="ghost" className="self-start" render={<Link to="/deposits" />}>
        <ArrowRightIcon className="rtl:-scale-x-100" />
        {t('deposits.detail.back')}
      </Button>
      <PageHeader
        title={t('deposits.transfers.title')}
        description={t('deposits.transfers.subtitle')}
      />
      <div className="flex flex-wrap items-end gap-4">
        <ToggleGroup<'unmatched' | 'all'>
          aria-label={t('deposits.transfers.stateFilter')}
          value={[search.state ?? 'unmatched']}
          onValueChange={(value) => {
            if (!value[0]) return;
            const { state: _previous, ...rest } = search;
            onSearch(value[0] === 'all' ? { ...rest, state: 'all' } : rest);
          }}
        >
          <ToggleGroupItem value="unmatched">
            {t('deposits.transfers.unmatchedOnly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="all">{t('deposits.transfers.all')}</ToggleGroupItem>
        </ToggleGroup>
        <Select
          items={networks}
          value={search.method ?? 'all'}
          onValueChange={(value) => {
            const { method: _previous, ...rest } = search;
            onSearch(value === 'all' ? rest : { ...rest, method: value as UsdtMethod });
          }}
        >
          <SelectTrigger aria-label={t('deposits.transfers.network')} className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {networks.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      )}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && transfers.length === 0 && (
        <EmptyState
          icon={<InboxIcon />}
          title={
            search.state === 'all'
              ? t('deposits.transfers.emptyAll')
              : t('deposits.transfers.emptyUnmatched')
          }
        />
      )}
      {transfers.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('deposits.transfers.columns.time')}</TableHead>
              <TableHead>{t('deposits.transfers.columns.network')}</TableHead>
              <TableHead>{t('deposits.transfers.columns.from')}</TableHead>
              <TableHead>{t('deposits.transfers.columns.amount')}</TableHead>
              <TableHead>{t('deposits.transfers.columns.txid')}</TableHead>
              <TableHead>{t('deposits.transfers.columns.state')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfers.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} onRecord={setRecording} />
            ))}
          </TableBody>
        </Table>
      )}
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
      <Dialog open={recording !== null} onOpenChange={(open) => !open && setRecording(null)}>
        {recording && (
          <ManualDepositDialog transfer={recording} onDone={() => setRecording(null)} />
        )}
      </Dialog>
    </>
  );
}

function TransferRow({
  transfer,
  onRecord,
}: {
  transfer: AdminUsdtTransfer;
  onRecord: (transfer: AdminUsdtTransfer) => void;
}) {
  const { t } = useTranslation();
  const unmatched = transfer.state === 'unmatched';
  return (
    <>
      <TableRow>
        <TableCell className="whitespace-nowrap">{formatDateTime(transfer.blockTime)}</TableCell>
        <TableCell className="whitespace-nowrap">
          {t(`wallets.methods.${transfer.method}`)}
        </TableCell>
        <TableCell className="min-w-64 whitespace-normal">
          {/* In full: look-alike addresses share their ends (address poisoning). */}
          <code dir="ltr" className="break-all">
            {transfer.fromAddress}
          </code>
        </TableCell>
        <TableCell className="font-medium whitespace-nowrap tabular-nums">
          {usdtText(transfer.amountUnits)}
        </TableCell>
        <TableCell>
          <ExplorerLink href={transfer.explorerUrl}>
            <code dir="ltr" title={transfer.txid}>
              {short(transfer.txid)}
            </code>
          </ExplorerLink>
        </TableCell>
        <TableCell className="min-w-40 whitespace-normal">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE_TONES[transfer.state]}>
              {t(`deposits.transfers.states.${transfer.state}`)}
            </Badge>
            {transfer.holder?.kind === 'deposit' && (
              <Link
                to="/deposits/$id"
                params={{ id: transfer.holder.id }}
                className="rounded-sm text-sm underline underline-offset-4"
              >
                {transfer.holder.customer.name}
              </Link>
            )}
            {transfer.holder?.kind === 'adjustment' && (
              <Link
                to="/wallets/$customerId"
                params={{ customerId: transfer.holder.customer.id }}
                className="rounded-sm text-sm underline underline-offset-4"
              >
                {transfer.holder.customer.name}
              </Link>
            )}
          </span>
        </TableCell>
      </TableRow>
      {unmatched && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="whitespace-normal">
            <div className="flex flex-col gap-3 py-1">
              <p className="text-sm font-medium">{t('deposits.transfers.candidates')}</p>
              <CandidateList candidates={transfer.candidates} />
              <Button variant="outline" className="self-start" onClick={() => onRecord(transfer)}>
                <NotebookPenIcon />
                {t('deposits.transfers.record')}
              </Button>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Rule U13: picks the customer (a candidate's, or by search), then opens the S02 manual deposit
 * with the network, the TXID and the amount floored to whole cents. The form claims the TXID, so
 * the transfer can never be credited twice.
 */
function ManualDepositDialog({
  transfer,
  onDone,
}: {
  transfer: AdminUsdtTransfer;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const wallet = useQuery({ ...walletQuery(customerId ?? ''), enabled: customerId !== null });

  if (customerId && wallet.isSuccess) {
    return (
      <AdjustDialog
        wallet={wallet.data}
        prefill={{
          method: transfer.method,
          reference: transfer.txid,
          amountText: formatAmountInput('USD', floorToWholeCents(transfer.amountUnits)),
        }}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['deposits'] });
          onDone();
        }}
      />
    );
  }
  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('deposits.transfers.record')}</DialogTitle>
        <DialogDescription>
          {t('deposits.transfers.pickCustomer', { amount: usdtText(transfer.amountUnits) })}
        </DialogDescription>
      </DialogHeader>
      <dl className="flex flex-col gap-1 text-sm">
        <dt className="text-muted-foreground">{t('deposits.usdt.from')}</dt>
        <dd className="font-medium break-all" dir="ltr">
          <code>{transfer.fromAddress}</code>
        </dd>
      </dl>
      {customerId && wallet.isPending && <Skeleton className="h-24 w-full" aria-hidden="true" />}
      {wallet.isError && <FormAlert>{errorMessage(t, wallet.error)}</FormAlert>}
      {transfer.candidates.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('deposits.transfers.candidateCustomers')}</p>
          {[...new Map(transfer.candidates.map((item) => [item.customer.id, item.customer]))]
            .map(([, customer]) => customer)
            .map((customer) => (
              <Button
                key={customer.id}
                variant="outline"
                className="h-auto justify-start py-2"
                onClick={() => setCustomerId(customer.id)}
              >
                <span className="flex flex-col items-start">
                  <span>{customer.name}</span>
                  <span dir="ltr" className="text-sm text-muted-foreground">
                    {customer.email}
                  </span>
                </span>
              </Button>
            ))}
        </div>
      )}
      <CustomerSearch onPick={setCustomerId} />
    </DialogContent>
  );
}

function CustomerSearch({ onPick }: { onPick: (customerId: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const q = text.trim();
  const results = useInfiniteQuery({ ...walletSearchQuery(q), enabled: q.length >= 3 });
  const customers = results.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <Field>
        <FieldLabel>{t('deposits.transfers.searchCustomer')}</FieldLabel>
        <Input
          type="search"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {results.isError && <FormAlert>{errorMessage(t, results.error)}</FormAlert>}
      {results.isSuccess && customers.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('deposits.transfers.noCustomers')}</p>
      )}
      {customers.map((customer) => (
        <Button
          key={customer.id}
          variant="ghost"
          className="h-auto justify-start py-2"
          onClick={() => onPick(customer.id)}
        >
          <span className="flex flex-col items-start">
            <span>{customer.name}</span>
            <span dir="ltr" className="text-sm text-muted-foreground">
              {customer.email}
            </span>
          </span>
        </Button>
      ))}
    </div>
  );
}
