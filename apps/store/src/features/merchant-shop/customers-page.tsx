'use client';

import {
  createShopCustomerSchema,
  formatSyp,
  formatUsd,
  type MerchantShop,
  type ShopCustomerRow,
  updateShopCustomerSchema,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vertex-digital/ui/components/dropdown-menu';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  EllipsisVerticalIcon,
  LoaderCircleIcon,
  SearchIcon,
  UserPlusIcon,
  UsersIcon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import {
  MerchantPageStatus,
  MerchantSkeleton,
  useMerchantRead,
} from '@/features/merchant-tools/merchant-state';
import { balanceSyp } from '@/features/shop/money';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { useIdempotentRequest } from '@/lib/idempotency';
import { tsa } from './i18n';
import {
  cancelReturn,
  createCustomer,
  getShop,
  inviteAgain,
  listCustomers,
  requestReturn,
  updateCustomer,
} from './requests';
import { returnAmount } from './rules';
import { NoShop } from './shop-gate';
import { TransferDialog } from './transfer-dialog';

const STATE_TONES = {
  invited: 'info',
  unverified: 'warning',
  active: 'success',
  frozen: 'danger',
  archived: 'neutral',
} as const;

type Dialogs =
  | { kind: 'create' }
  | { kind: 'edit'; customer: ShopCustomerRow }
  | { kind: 'transfer'; customer: ShopCustomerRow }
  | { kind: 'return'; customer: ShopCustomerRow }
  | null;

/**
 * "الزبائن" (S26 Screens, CA1, CA3, CA6–CA9, WL1–WL6): the shop's customers with their balance,
 * a search, "زبون جديد", and per customer "شحن رصيد", "طلب إرجاع", the invitation again, an edit
 * of name and phone, and their orders. Actions need the shop active (read only otherwise).
 */
export function CustomersPage() {
  const read = useCallback(() => getShop(), []);
  const { state, setState, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  const { shop } = state.data;
  if (!shop || shop.status === 'requested' || shop.status === 'rejected') return <NoShop />;
  return (
    <CustomerList
      shop={shop}
      onShop={(next) => setState({ status: 'ready', data: { shop: next } })}
    />
  );
}

function CustomerList({
  shop,
  onShop,
}: {
  shop: MerchantShop;
  onShop: (shop: MerchantShop) => void;
}) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ShopCustomerRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const active = shop.status === 'active';

  // The search reads once typing pauses; only the newest read lands.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async (search: string) => {
    const reading = ++latest.current;
    setFailed(false);
    const result = await listCustomers({ q: search });
    if (reading !== latest.current) return;
    if (!result.ok) return setFailed(true);
    setRows(result.data.items);
    setCursor(result.data.nextCursor);
  }, []);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    const result = await listCustomers({ q: query, cursor });
    setLoadingMore(false);
    if (!result.ok) return setFailed(true);
    setRows((current) => [...(current ?? []), ...result.data.items]);
    setCursor(result.data.nextCursor);
  }

  const replace = (row: ShopCustomerRow) =>
    setRows((current) => current?.map((item) => (item.id === row.id ? row : item)) ?? null);

  async function invite(customer: ShopCustomerRow) {
    setNotice(null);
    const result = await inviteAgain(customer.id);
    setNotice(result.ok ? tsa('customers.invited') : errorText(result.reason));
  }

  async function cancel(customer: ShopCustomerRow) {
    if (!customer.pendingReturn) return;
    setNotice(null);
    const result = await cancelReturn(customer.id, customer.pendingReturn.id);
    if (!result.ok) return setNotice(errorText(result.reason));
    replace({ ...customer, pendingReturn: null });
    setNotice(tsa('returns.cancelled'));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={tsa('customers.search')}
            placeholder={tsa('customers.search')}
            className="h-11 ps-9 text-md"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        {active && (
          <Button size="xl" onClick={() => setDialog({ kind: 'create' })}>
            <UserPlusIcon aria-hidden="true" />
            {tsa('customers.new')}
          </Button>
        )}
      </div>
      {!active && <p className="text-sm text-muted-foreground">{tsa('common.inactive')}</p>}
      {notice && (
        <p
          role="status"
          className="rounded-md bg-status-info px-4 py-3 text-sm text-status-info-foreground"
        >
          {notice}
        </p>
      )}
      {failed && rows === null ? (
        <EmptyState
          title={tsa('common.loadFailed')}
          action={
            <Button variant="outline" size="xl" onClick={() => void load(query)}>
              {tsa('common.retry')}
            </Button>
          }
        />
      ) : rows === null ? (
        <MerchantSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title={query ? tsa('customers.noMatch') : tsa('customers.empty')}
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="shop-customers">
          {rows.map((customer) => (
            <CustomerCard
              key={customer.id}
              customer={customer}
              rate={shop.rate}
              active={active}
              onTransfer={() => setDialog({ kind: 'transfer', customer })}
              onReturn={() => setDialog({ kind: 'return', customer })}
              onCancelReturn={() => void cancel(customer)}
              onInvite={() => void invite(customer)}
              onEdit={() => setDialog({ kind: 'edit', customer })}
            />
          ))}
        </ul>
      )}
      {cursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {tsa('common.loadMore')}
        </Button>
      )}
      <CustomerDialog
        dialog={dialog?.kind === 'create' || dialog?.kind === 'edit' ? dialog : null}
        onClose={() => setDialog(null)}
        onSaved={(row, created) => {
          setDialog(null);
          if (created) {
            setRows((current) => [row, ...(current ?? [])]);
            setNotice(tsa('customers.created', { name: row.name }));
          } else replace(row);
        }}
      />
      {dialog?.kind === 'transfer' && (
        <TransferDialog
          shop={shop}
          customer={dialog.customer}
          onClose={(unsettled) => {
            setDialog(null);
            // A transfer that may have been written: the balances shown are read again.
            if (unsettled) void load(query);
          }}
          onDone={(result) => {
            replace({ ...dialog.customer, balanceUsdUnits: result.customerBalanceUsdUnits });
            onShop({ ...shop, transferredTodayUsdUnits: result.transferredTodayUsdUnits });
          }}
        />
      )}
      {dialog?.kind === 'return' && (
        <ReturnDialog
          customer={dialog.customer}
          onClose={() => setDialog(null)}
          onSent={(row) => {
            setDialog(null);
            replace(row);
            setNotice(tsa('returns.sent', { name: row.name }));
          }}
        />
      )}
    </div>
  );
}

function CustomerCard({
  customer,
  rate,
  active,
  onTransfer,
  onReturn,
  onCancelReturn,
  onInvite,
  onEdit,
}: {
  customer: ShopCustomerRow;
  rate: string | null;
  active: boolean;
  onTransfer: () => void;
  onReturn: () => void;
  onCancelReturn: () => void;
  onInvite: () => void;
  onEdit: () => void;
}) {
  const syp = balanceSyp(customer.balanceUsdUnits, rate);
  const usable = customer.state === 'active';
  return (
    <li>
      <Card
        className="gap-3 md:flex-row md:items-center md:justify-between"
        data-testid="shop-customer"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <bdi className="font-bold">{customer.name}</bdi>
            <Badge tone={STATE_TONES[customer.state]}>
              {tsa(`customers.states.${customer.state}`)}
            </Badge>
          </div>
          <span
            dir="ltr"
            className="text-end text-sm break-all text-muted-foreground md:text-start"
          >
            {customer.email} · {customer.phone}
          </span>
          {customer.pendingReturn && (
            <span className="text-sm text-status-warning-foreground">
              {tsa('customers.pendingReturn', {
                amount: ltr(formatUsd(customer.pendingReturn.amountUsdUnits)),
              })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 md:justify-end">
          <div className="flex flex-col md:items-end">
            <span className="text-xs text-muted-foreground">{tsa('customers.balance')}</span>
            <bdi dir="ltr" className="font-bold tabular-nums" data-testid="customer-balance">
              {formatUsd(customer.balanceUsdUnits)}
            </bdi>
            {syp !== null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {tsa('common.approx', { amount: tsa('common.syp', { amount: formatSyp(syp) }) })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {active && usable && (
              <Button size="xl" onClick={onTransfer}>
                <WalletIcon aria-hidden="true" />
                {tsa('customers.transfer')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="xl"
                    className="px-3"
                    aria-label={tsa('customers.more', { name: customer.name })}
                  />
                }
              >
                <EllipsisVerticalIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {active && usable && !customer.pendingReturn && customer.balanceUsdUnits > 0 && (
                  <DropdownMenuItem className="min-h-11" onClick={onReturn}>
                    {tsa('customers.return')}
                  </DropdownMenuItem>
                )}
                {active && customer.pendingReturn && (
                  <DropdownMenuItem className="min-h-11" onClick={onCancelReturn}>
                    {tsa('customers.cancelReturn')}
                  </DropdownMenuItem>
                )}
                {active && customer.state === 'invited' && (
                  <DropdownMenuItem className="min-h-11" onClick={onInvite}>
                    {tsa('customers.invite')}
                  </DropdownMenuItem>
                )}
                {active && customer.state !== 'archived' && (
                  <DropdownMenuItem className="min-h-11" onClick={onEdit}>
                    {tsa('customers.edit')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="min-h-11"
                  render={
                    <Link
                      href={`/merchant/shop/orders?customer=${encodeURIComponent(customer.id)}`}
                      prefetch={false}
                    />
                  }
                >
                  {tsa('customers.orders')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </Card>
    </li>
  );
}

/** CA1, CA3, CA8: a new customer (name, email, phone), or a customer's name and phone. */
function CustomerDialog({
  dialog,
  onClose,
  onSaved,
}: {
  dialog: { kind: 'create' } | { kind: 'edit'; customer: ShopCustomerRow } | null;
  onClose: () => void;
  onSaved: (row: ShopCustomerRow, created: boolean) => void;
}) {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={tsa('common.close')} className="max-w-lg">
        {dialog && (
          <CustomerForm
            key={dialog.kind === 'edit' ? dialog.customer.id : 'new'}
            dialog={dialog}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CustomerForm({
  dialog,
  onSaved,
}: {
  dialog: { kind: 'create' } | { kind: 'edit'; customer: ShopCustomerRow };
  onSaved: (row: ShopCustomerRow, created: boolean) => void;
}) {
  const editing = dialog.kind === 'edit' ? dialog.customer : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = useIdempotentRequest();
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = editing
      ? updateShopCustomerSchema.safeParse({ name, phone })
      : createShopCustomerSchema.safeParse({ name, email: email.trim(), phone });
    const paths = new Set(
      parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
    );
    setInvalid(paths);
    if (!parsed.success) return focusInvalid();
    setSending(true);
    const result = editing
      ? await updateCustomer(editing.id, { name, phone })
      : await send(JSON.stringify({ name, email, phone }), (key) =>
          createCustomer({ name, email: email.trim(), phone }, key),
        );
    setSending(false);
    if (result.ok) return onSaved(result.data, editing === null);
    if (result.reason === 'EMAIL_TAKEN') {
      setInvalid(new Set(['email']));
      setFailure(tsa('customers.emailTaken'));
      return focusInvalid();
    }
    setFailure(errorText(result.reason));
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {editing
            ? tsa('customers.editTitle', { name: editing.name })
            : tsa('customers.createTitle')}
        </DialogTitle>
        {!editing && <DialogDescription>{tsa('customers.createBody')}</DialogDescription>}
      </DialogHeader>
      <form
        ref={ref}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <Field invalid={invalid.has('name')}>
          <FieldLabel>{tsa('customers.name')}</FieldLabel>
          <Input
            name="name"
            autoComplete="off"
            className="h-11 text-md"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldError match={invalid.has('name')}>{tsa('customers.nameInvalid')}</FieldError>
        </Field>
        <Field invalid={invalid.has('email')} disabled={editing !== null}>
          <FieldLabel>{tsa('customers.email')}</FieldLabel>
          <Input
            name="email"
            type="email"
            dir="ltr"
            autoComplete="off"
            className="h-11 text-md"
            disabled={editing !== null}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {editing && <FieldDescription>{tsa('customers.emailFixed')}</FieldDescription>}
          <FieldError match={invalid.has('email') && failure === null}>
            {tsa('customers.emailInvalid')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('phone')}>
          <FieldLabel>{tsa('customers.phone')}</FieldLabel>
          <Input
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="off"
            className="h-11 text-md"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <FieldError match={invalid.has('phone')}>{tsa('customers.phoneInvalid')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <Button type="submit" size="xl" disabled={sending}>
          {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {editing ? tsa('common.save') : tsa('customers.create')}
        </Button>
      </form>
    </>
  );
}

/** WL5: the merchant asks for an amount back; the customer confirms it in the shop. */
function ReturnDialog({
  customer,
  onClose,
  onSent,
}: {
  customer: ShopCustomerRow;
  onClose: () => void;
  onSent: (row: ShopCustomerRow) => void;
}) {
  const [typed, setTyped] = useState('');
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = useIdempotentRequest();
  const { ref, focusInvalid } = useFocusInvalid();
  const amount = returnAmount(typed, customer.balanceUsdUnits);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowError(true);
    setFailure(null);
    if (amount === null) return focusInvalid();
    setSending(true);
    const result = await send(JSON.stringify({ id: customer.id, amount }), (key) =>
      requestReturn(customer.id, amount, key),
    );
    setSending(false);
    if (result.ok) {
      return onSent({
        ...customer,
        pendingReturn: {
          id: result.data.id,
          amountUsdUnits: result.data.amountUsdUnits,
          expiresAt: result.data.expiresAt,
        },
      });
    }
    setFailure(
      result.reason === 'RETURN_REQUEST_PENDING'
        ? tsa('returns.pending')
        : errorText(result.reason),
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={tsa('common.close')} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tsa('returns.title', { name: customer.name })}</DialogTitle>
          <DialogDescription>{tsa('returns.body')}</DialogDescription>
        </DialogHeader>
        <form
          ref={ref}
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <Field invalid={showError && amount === null}>
            <FieldLabel>{tsa('returns.amount')}</FieldLabel>
            <Input
              name="amount"
              dir="ltr"
              inputMode="decimal"
              className="h-11 text-md"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <FieldDescription>
              {tsa('returns.max', { amount: ltr(formatUsd(customer.balanceUsdUnits)) })}
            </FieldDescription>
            <FieldError match={showError && amount === null}>
              {tsa('returns.amountInvalid')}
            </FieldError>
          </Field>
          {failure && <FormAlert>{failure}</FormAlert>}
          <Button type="submit" size="xl" disabled={sending}>
            {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {tsa('returns.send')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
