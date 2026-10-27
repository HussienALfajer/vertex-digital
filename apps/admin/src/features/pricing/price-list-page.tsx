import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FixedPrice, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { TagIcon, UsersRoundIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { customerListQuery, useSetCustomerPriceList } from '../customers/customers.queries';
import { FixedPriceDialog, SourceBadge } from './fixed-price-dialog';
import { ListRules } from './list-rules';
import { KindBadge } from './price-lists-page';
import { listRulesQuery, priceListQuery, useArchiveFixedPrice } from './pricing.queries';

/** How long typing must pause before the account search reads. */
const SEARCH_PAUSE_MS = 300;

/**
 * A list's page (S20 screens): its chain, its rules (the parent's shown where it has none), its
 * fixed prices with the price each gives today, and the accounts assigned to it (the cost and
 * custom lists: assigned by a customer search).
 */
export function PriceListPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const detail = useQuery(priceListQuery(id));
  const chain = detail.data?.chain ?? [];
  const rules = useQueries({ queries: chain.map((item) => listRulesQuery(item.id)) });
  const [editing, setEditing] = useState<FixedPrice | 'new' | null>(null);
  const [archiving, setArchiving] = useState<FixedPrice | null>(null);
  const [assigning, setAssigning] = useState(false);
  const archive = useArchiveFixedPrice();

  if (detail.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (detail.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, detail.error)}</FormAlert>
        <Button variant="outline" onClick={() => detail.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const { list, fixedPrices, accounts } = detail.data;
  const live = list.archivedAt === null;
  const chainRules = rules.flatMap((read) => read.data ?? []);
  const rulesReady = rules.every((read) => read.isSuccess);

  return (
    <>
      <PageHeader
        title={list.name}
        description={t('pricing.list.chain', {
          chain: chain.map((item) => item.name).join(' ← '),
        })}
        actions={
          <span className="flex items-center gap-2">
            <KindBadge kind={list.kind} />
            {!live && <Badge tone="outline">{t('pricing.lists.archived')}</Badge>}
          </span>
        }
      />
      <div className="flex flex-col gap-8">
        {live && list.ready && <ListRules chain={chain} />}
        {live && !list.ready && <Callout tone="warning" title={t('pricing.list.notReady')} />}
        <section className="flex flex-col gap-3" aria-labelledby="fixed-prices">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="fixed-prices" className="text-lg font-bold">
              {t('pricing.list.fixedTitle')}
            </h2>
            {live && list.ready && (
              <Button variant="outline" disabled={!rulesReady} onClick={() => setEditing('new')}>
                {t('pricing.list.addFixed')}
              </Button>
            )}
          </div>
          {fixedPrices.length === 0 ? (
            <EmptyState
              icon={<TagIcon />}
              title={t('pricing.list.fixedEmpty')}
              description={t('pricing.list.fixedEmptyHint')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('pricing.columns.product')}</TableHead>
                  <TableHead>{t('pricing.fixed.price')}</TableHead>
                  <TableHead>{t('pricing.list.priceNow')}</TableHead>
                  <TableHead>{t('pricing.list.margin')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('pricing.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fixedPrices.map((fixed) => (
                  <TableRow key={fixed.id}>
                    <TableCell className="whitespace-normal">
                      <span className="font-medium">{fixed.productNameAr}</span>
                      <span className="block text-xs text-muted-foreground">
                        {fixed.gameNameAr}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {ltr(formatUsd(fixed.priceUsdUnits))}
                    </TableCell>
                    <TableCell>
                      {fixed.result.priceUsdUnits === null ? (
                        '—'
                      ) : (
                        <span className="flex flex-wrap items-center gap-2 tabular-nums">
                          {ltr(formatUsd(fixed.result.priceUsdUnits))}
                          {fixed.result.source && <SourceBadge source={fixed.result.source} />}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {fixed.result.marginUsdUnits === null
                        ? '—'
                        : ltr(formatUsd(fixed.result.marginUsdUnits))}
                    </TableCell>
                    <TableCell>
                      {live && (
                        <span className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!rulesReady}
                            onClick={() => setEditing(fixed)}
                          >
                            {t('pricing.actions.edit')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setArchiving(fixed)}>
                            {t('pricing.list.removeFixed')}
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>{t('pricing.list.accountsTitle', { number: list.accounts })}</CardTitle>
              <CardDescription>
                {list.kind === 'retail' || list.kind === 'wholesale'
                  ? t('pricing.list.accountsDefaultHint')
                  : t('pricing.list.accountsHint')}
              </CardDescription>
            </div>
            {live && list.ready && (list.kind === 'cost' || list.kind === 'custom') && (
              <Button variant="outline" onClick={() => setAssigning(true)}>
                {t('pricing.list.assign')}
              </Button>
            )}
          </CardHeader>
          {accounts.length === 0 ? (
            <EmptyState icon={<UsersRoundIcon />} title={t('pricing.list.accountsEmpty')} />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {accounts.map((account) => (
                <li key={account.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link
                    to="/customers/$id"
                    params={{ id: account.id }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {account.name}
                  </Link>
                  <bdi dir="ltr" className="text-sm text-muted-foreground">
                    {account.email}
                  </bdi>
                  {account.accountType === 'merchant' && (
                    <Badge tone="gold">{t('pricing.list.merchant')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <FixedPriceDialog
            listId={list.id}
            chain={list.chain}
            rules={chainRules}
            initial={
              editing === 'new'
                ? undefined
                : {
                    gameId: editing.gameId,
                    productId: editing.productId,
                    priceUsdUnits: editing.priceUsdUnits,
                  }
            }
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title={t('pricing.list.removeFixedTitle')}
        body={t('pricing.list.removeFixedBody', { name: archiving?.productNameAr ?? '' })}
        action={t('pricing.list.removeFixed')}
        destructive
        pending={archive.isPending}
        onConfirm={async () => {
          if (archiving) {
            await archive.mutateAsync({ listId: list.id, productId: archiving.productId });
          }
        }}
      />
      <Dialog open={assigning} onOpenChange={setAssigning}>
        {assigning && (
          <AssignAccountDialog
            listId={list.id}
            listName={list.name}
            onDone={() => setAssigning(false)}
          />
        )}
      </Dialog>
    </>
  );
}

/** AT2 from the list: a customer found by search, then the reason (re-authentication). */
function AssignAccountDialog({
  listId,
  listName,
  onDone,
}: {
  listId: string;
  listName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  // One read once typing pauses, not one per keystroke (audit A05-79).
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  const found = useInfiniteQuery({
    ...customerListQuery({ q: search }),
    enabled: search.length >= 2 && !chosen,
  });
  const assign = useSetCustomerPriceList(chosen?.id ?? '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const trimmed = reason.trim();
    if (!chosen || trimmed.length < 5 || trimmed.length > 500) {
      setInvalid(true);
      return focusInvalid();
    }
    setInvalid(false);
    try {
      await assign.mutateAsync({ priceListId: listId, reason: trimmed });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const rows = found.data?.pages.flatMap((page) => page.items).slice(0, 8) ?? [];
  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('pricing.list.assignTitle', { name: listName })}</DialogTitle>
        <DialogDescription>{t('pricing.list.assignHint')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {chosen ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted p-3">
            <span className="font-medium">{chosen.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
              {t('pricing.list.change')}
            </Button>
          </div>
        ) : (
          <Field invalid={invalid && !chosen}>
            <FieldLabel>{t('pricing.list.customer')}</FieldLabel>
            <Input
              name="q"
              autoComplete="off"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
            <FieldError match={invalid && !chosen}>{t('pricing.list.customerRequired')}</FieldError>
            {search.length >= 2 && found.isPending && <Skeleton className="h-20 w-full" />}
            {found.isError && (
              <div className="flex flex-col items-start gap-2">
                <FormAlert>{errorMessage(t, found.error)}</FormAlert>
                <Button variant="outline" size="sm" onClick={() => found.refetch()}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {found.isSuccess && rows.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('pricing.list.noCustomer')}</p>
            )}
            {rows.length > 0 && (
              <ul className="flex flex-col gap-1">
                {rows.map((row) => (
                  <li key={row.id}>
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => setChosen({ id: row.id, name: row.name })}
                    >
                      {row.name} · <bdi dir="ltr">{row.email}</bdi>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        <Field invalid={invalid && !!chosen}>
          <FieldLabel>{t('pricing.list.reason')}</FieldLabel>
          <Textarea
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <FieldError match={invalid && !!chosen}>{t('pricing.list.reasonInvalid')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={assign.isPending}>
            {assign.isPending ? t('pricing.form.saving') : t('pricing.list.assign')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
