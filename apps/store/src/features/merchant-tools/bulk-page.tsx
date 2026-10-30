'use client';

import {
  BULK_LINES_MAX,
  BULK_TEXT_MAX_BYTES,
  type BulkCheckLine,
  type BulkCheckResult,
  type CheckoutLineRefusal,
  checkoutTotal,
  formatUsd,
  type MerchantGame,
  type StoreGame,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { Field, FieldDescription, FieldLabel } from '@vertex-digital/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui/components/select';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { DownloadIcon, FileUpIcon, SearchCheckIcon, TrashIcon, WalletIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { freesCheckoutKey } from '@/features/cart/checkout-key';
import { lineRefusals, payCart } from '@/features/cart/requests';
import { centsParam } from '@/features/deposits/amounts';
import { sendAttempt } from '@/features/purchase/attempt';
import { usePurchasesStopped } from '@/features/purchase/customer';
import { isFrozenCustomer, useCustomer } from '@/features/purchase/session';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { clearFormDraft, readFormDraft, saveFormDraft } from '@/lib/form-draft';
import { formatDateTime, ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { FreshOnShow } from '@/lib/shown-again';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { checkBulk, getMerchantGames, readCounterGame } from './requests';
import { useMerchantTier } from './tier-state';

// S20 MT2: a directly granted merchant accepts the terms here, loaded only on that refusal.
const TermsSheet = dynamic(() =>
  import('@/features/merchant/terms-sheet').then((module) => module.TermsSheet),
);

/**
 * The payment's key slot in session storage, apart from the cart's: a retry of the same lines
 * after a lost answer, even after a reload, replays the first checkout (rule CT5, audit A06-5).
 */
const ATTEMPT = 'bulk';

/** BK5: the last 10 bulk payments kept on this device (ids and counts, nothing personal). */
const RECENT_KEY = 'vd-bulk-checkouts';

/** The game and the pasted lines, until they are paid: a long list survives a link or a reload. */
const DRAFT = 'bulk';

type BulkDraft = { gameId: string | null; text: string };

type RecentCheckout = { id: string; count: number; at: string };

function readRecent(): RecentCheckout[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? (value as RecentCheckout[]).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function keepRecent(entry: RecentCheckout): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...readRecent()].slice(0, 10)));
  } catch {
    // Without storage the list stays empty.
  }
}

/** BK1: the game's template: a header line naming the columns, then one example per pack. */
function template(game: StoreGame): string {
  const keys = game.fields.map((field) => field.key);
  const lines = [`# ${[...keys, 'pack', 'quantity'].join(', ')}`];
  for (const pack of game.products) {
    const example = keys.map((key) => (key.includes('id') ? '5123456789' : key));
    lines.push([...example, pack.gameAmount ?? pack.nameAr, '1'].join(', '));
  }
  return `${lines.join('\n')}\n`;
}

function stateOf(line: BulkCheckLine, confirmed: boolean): 'ok' | 'confirm' | 'invalid' {
  if (line.errors.length > 0 || line.totalUsdUnits === null) return 'invalid';
  return line.needsConfirmation && !confirmed ? 'confirm' : 'ok';
}

const STATE_TONES = { ok: 'success', confirm: 'warning', invalid: 'danger' } as const;

/**
 * "طلبات بالجملة" (S21 F33, BK1–BK5): a game, then up to the tier's lines (S23 TS5) pasted or from a CSV with the
 * game's template; "فحص" checks every line on the merchant's list with each id checked once
 * (the merchant's quota); the table marks errors and asks a tick for ids not known valid; the
 * total against the balance; "ادفع الكل" pays all or nothing through the S10 checkout, then
 * follows the orders live. Invalid lines block paying until fixed or removed.
 */
export function BulkPage() {
  return (
    <FreshOnShow>
      <BulkRead />
    </FreshOnShow>
  );
}

function BulkRead() {
  const read = useCallback(() => getMerchantGames(), []);
  const { state, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  return <BulkForm games={state.data.items} />;
}

function BulkForm({ games }: { games: MerchantGame[] }) {
  const router = useRouter();
  const [saved] = useState(() => readFormDraft<BulkDraft>(DRAFT));
  const [gameId, setGameId] = useState<string | null>(
    games.find((item) => item.id === saved?.gameId)?.id ?? games[0]?.id ?? null,
  );
  const [text, setText] = useState(typeof saved?.text === 'string' ? saved.text : '');
  const [result, setResult] = useState<BulkCheckResult | null>(null);
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [refusals, setRefusals] = useState<Map<number, CheckoutLineRefusal>>(new Map());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recent] = useState(readRecent);
  const fileRef = useRef<HTMLInputElement>(null);
  // S21 MA1: a frozen merchant reads only; S20 MT2: the terms sheet after a refusal.
  const frozen = isFrozenCustomer(useCustomer());
  // S05 SW7, BB7: no check (it spends the hour's checks) and no payment while stopped (A09-24).
  const stopped = usePurchasesStopped();
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const game = games.find((item) => item.id === gameId) ?? null;
  // Paid, on the way to its orders: nothing may be pressed again (the key is freed).
  const paid = useRef(false);
  useEffect(() => {
    if (paid.current) return;
    if (text === '') clearFormDraft(DRAFT);
    else saveFormDraft(DRAFT, { gameId, text } satisfies BulkDraft);
  }, [gameId, text]);
  const bulkLinesMax = useMerchantTier().tier?.privileges.bulkLinesMax ?? BULK_LINES_MAX;

  async function check() {
    if (!gameId || text.trim() === '') return;
    setFailure(null);
    setNotice(null);
    setTermsAccepted(false);
    setRefusals(new Map());
    setPending(true);
    const answer = await checkBulk({ gameId, text });
    setPending(false);
    if (!answer.ok) {
      if (answer.reason === 'MERCHANT_TERMS_REQUIRED') setTermsOpen(true);
      return setFailure(answer.reason);
    }
    setResult(answer.data);
    setConfirmed(new Set());
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > BULK_TEXT_MAX_BYTES) return setNotice(tm('bulk.uploadTooBig'));
    setText(await file.text());
    setResult(null);
  }

  async function download() {
    if (!game) return;
    const store = await readCounterGame(game.slug);
    if (!store.ok) return setFailure(store.reason);
    const url = URL.createObjectURL(new Blob([template(store.data)], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${game.slug}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const lines = result?.lines ?? [];
  const states = lines.map((line) => stateOf(line, confirmed.has(line.line)));
  const invalidCount = states.filter((value) => value === 'invalid').length;
  const confirmCount = states.filter((value) => value === 'confirm').length;
  const total = checkoutTotal(
    lines.flatMap((line) =>
      line.unitPriceUsdUnits !== null && line.quantity !== null && line.totalUsdUnits !== null
        ? [{ unitPriceUsdUnits: line.unitPriceUsdUnits, quantity: line.quantity }]
        : [],
    ),
  );
  const balance = result?.balanceUsdUnits ?? 0;
  const shortfall = total > balance ? total - balance : 0;
  // Nothing is sent that is sure to be refused: a frozen account, a line to fix or confirm, or a
  // total above the balance (audit A06-4, A06-10).
  const payable =
    result !== null &&
    !frozen &&
    !stopped &&
    invalidCount === 0 &&
    confirmCount === 0 &&
    lines.length > 0 &&
    shortfall === 0;

  async function pay() {
    if (!payable || paid.current) return;
    setFailure(null);
    setTermsAccepted(false);
    setRefusals(new Map());
    setPending(true);
    const body = {
      source: 'bulk' as const,
      lines: lines.map((line) => ({
        productId: line.product?.id as string,
        quantity: line.quantity as number,
        fields: line.fields,
        expectedUnitPriceUsdUnits: line.unitPriceUsdUnits as number,
        confirmPlayer: line.needsConfirmation && confirmed.has(line.line),
      })),
    };
    const answer = await sendAttempt(
      ATTEMPT,
      JSON.stringify(body),
      (key) => payCart(body, key),
      freesCheckoutKey,
    );
    if (!answer.ok) {
      setPending(false);
      if (answer.reason === 'CHECKOUT_REFUSED') setRefusals(lineRefusals(answer.details));
      if (answer.reason === 'MERCHANT_TERMS_REQUIRED') setTermsOpen(true);
      return setFailure(answer.reason);
    }
    // Stays busy until the page is left: the key is freed, so another press would pay again. Coming
    // back mounts a new, empty form (`FreshOnShow`).
    paid.current = true;
    clearFormDraft(DRAFT);
    keepRecent({
      id: answer.data.id,
      count: answer.data.orders.length,
      at: new Date().toISOString(),
    });
    router.push(`/orders?checkout=${answer.data.id}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold">{tm('bulk.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {tm('bulk.body', { count: bulkLinesMax })}
          </p>
        </div>
        {frozen && <FormAlert>{tm('common.frozen')}</FormAlert>}
        {stopped && <FormAlert>{t('purchase.stopped')}</FormAlert>}
        <Field>
          <FieldLabel>{tm('bulk.game')}</FieldLabel>
          <Select
            value={gameId}
            onValueChange={(value) => {
              setGameId(value as string);
              setResult(null);
            }}
          >
            <SelectTrigger className="h-11 w-full text-md sm:w-80">
              <SelectValue placeholder={tm('bulk.chooseGame')}>
                {(value: string | null) => games.find((item) => item.id === value)?.nameAr}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {games.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.nameAr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{tm('bulk.text')}</FieldLabel>
          <Textarea
            name="lines"
            dir="ltr"
            rows={8}
            className="text-md"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(null);
            }}
          />
          <FieldDescription>{tm('bulk.textHint')}</FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            aria-label={tm('bulk.upload')}
            onChange={(event) => void pick(event)}
          />
          <Button variant="outline" size="xl" onClick={() => fileRef.current?.click()}>
            <FileUpIcon aria-hidden="true" />
            {tm('bulk.upload')}
          </Button>
          <Button variant="ghost" size="xl" disabled={!game} onClick={() => void download()}>
            <DownloadIcon aria-hidden="true" />
            {tm('bulk.template')}
          </Button>
          <Button
            size="xl"
            disabled={frozen || stopped || pending || !game || text.trim() === ''}
            onClick={() => void check()}
          >
            <SearchCheckIcon aria-hidden="true" />
            {pending && !result ? tm('bulk.checking') : tm('bulk.check')}
          </Button>
        </div>
        {notice && <FormAlert>{notice}</FormAlert>}
        {failure && !result && <FormAlert>{errorText(failure)}</FormAlert>}
        {termsAccepted && <FormAlert tone="success">{tm('bulk.termsAccepted')}</FormAlert>}
      </Card>
      {termsOpen && (
        <TermsSheet
          open={termsOpen}
          onOpenChange={setTermsOpen}
          onAccepted={() => {
            setFailure(null);
            setTermsAccepted(true);
          }}
        />
      )}

      {result && (
        <Card className="gap-4">
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line, index) => {
              const value = states[index] ?? 'invalid';
              const refusal = refusals.get(index);
              return (
                <li key={line.line} className="flex flex-col gap-2 py-3" data-state={value}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={STATE_TONES[value]}>
                        {value === 'ok'
                          ? tm('bulk.ok')
                          : value === 'confirm'
                            ? tm('bulk.needsConfirm')
                            : tm('bulk.invalid')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {tm('bulk.line')} {line.line}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {line.totalUsdUnits !== null && (
                        <bdi dir="ltr" className="font-bold tabular-nums">
                          {formatUsd(line.totalUsdUnits)}
                        </bdi>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        aria-label={tm('bulk.remove')}
                        onClick={() => {
                          setResult({ ...result, lines: lines.filter((item) => item !== line) });
                          setRefusals(new Map());
                        }}
                      >
                        <TrashIcon aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                  <p className="text-sm">
                    {line.product ? <bdi>{line.product.nameAr}</bdi> : '—'}
                    {line.quantity !== null && line.quantity > 1 && ` × ${line.quantity}`}
                    {Object.keys(line.fields).length > 0 && (
                      <>
                        {' · '}
                        <bdi dir="ltr">{Object.values(line.fields).join(' · ')}</bdi>
                      </>
                    )}
                  </p>
                  {line.unitPriceUsdUnits !== null && (
                    <p className="text-xs text-muted-foreground">
                      {tm('bulk.unitPrice', { amount: ltr(formatUsd(line.unitPriceUsdUnits)) })}
                    </p>
                  )}
                  {line.check && (
                    <p className="text-sm text-muted-foreground">
                      {line.check.result === 'valid'
                        ? line.check.playerName
                          ? tm('bulk.checks.valid', { name: line.check.playerName })
                          : tm('bulk.checks.validNoName')
                        : line.check.result === 'unavailable' && line.check.reason === 'quota'
                          ? tm('bulk.checks.quota')
                          : tm(`bulk.checks.${line.check.result}`)}
                    </p>
                  )}
                  {line.errors.map((error) => (
                    <p
                      key={`${error.code}:${error.field ?? ''}`}
                      className="text-sm text-status-danger-foreground"
                    >
                      {tm(`bulk.errors.${error.code}`, { field: error.field ?? '' })}
                    </p>
                  ))}
                  {refusal && (
                    <p className="text-sm text-status-danger-foreground">
                      {tm(`bulk.refusals.${refusal.code}`)}
                    </p>
                  )}
                  {line.needsConfirmation && line.errors.length === 0 && (
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={confirmed.has(line.line)}
                        onChange={(event) => {
                          const next = new Set(confirmed);
                          if (event.target.checked) next.add(line.line);
                          else next.delete(line.line);
                          setConfirmed(next);
                        }}
                      />
                      {tm('bulk.confirm')}
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
          <dl className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{tm('bulk.total')}</dt>
              <dd>
                <bdi dir="ltr" className="font-bold">
                  {formatUsd(total)}
                </bdi>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{tm('bulk.balance')}</dt>
              <dd>
                <bdi dir="ltr">{formatUsd(balance)}</bdi>
              </dd>
            </div>
          </dl>
          {shortfall > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted p-3">
              <p className="text-sm">
                {tm('bulk.shortfall', { amount: ltr(formatUsd(shortfall)) })}
              </p>
              <Button
                variant="outline"
                size="xl"
                render={
                  <Link href={`/wallet/deposit?gap=${centsParam(shortfall)}`} prefetch={false} />
                }
              >
                <WalletIcon aria-hidden="true" />
                {tm('bulk.topUp')}
              </Button>
            </div>
          )}
          {invalidCount > 0 && <FormAlert>{tm('bulk.fixFirst')}</FormAlert>}
          {invalidCount === 0 && confirmCount > 0 && (
            <FormAlert>{tm('bulk.confirmFirst')}</FormAlert>
          )}
          {failure && (
            <FormAlert>
              {failure === 'CHECKOUT_REFUSED' ? tm('bulk.refused') : errorText(failure)}
            </FormAlert>
          )}
          <Button size="xl" disabled={pending || !payable} onClick={() => void pay()}>
            {pending ? tm('bulk.paying') : tm('bulk.payTotal', { amount: ltr(formatUsd(total)) })}
          </Button>
        </Card>
      )}

      <Card className="gap-3">
        <h2 className="font-bold">{tm('bulk.recent')}</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('bulk.recentEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/orders?checkout=${entry.id}`}
                  prefetch={false}
                  className="flex min-h-11 items-center justify-between gap-2 text-sm hover:underline"
                >
                  {tm('bulk.recentItem', { count: entry.count, date: formatDateTime(entry.at) })}
                  <span className="text-muted-foreground">{tm('bulk.follow')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
