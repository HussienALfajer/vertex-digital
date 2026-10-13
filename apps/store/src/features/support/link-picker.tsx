'use client';

import { formatUsd } from '@vertex-digital/contracts';
import { Badge, type BadgeProps } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useCallback, useEffect, useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { STATUS_TONES as DEPOSIT_TONES, statusText } from '@/features/deposits/amounts';
import { getDeposit } from '@/features/deposits/requests';
import { getOrder } from '@/features/orders/requests';
import { STAGE_TONES, stageText } from '@/features/orders/stages';
import { t } from '@/lib/i18n';
import { recentDeposits, recentOrders } from './requests';

/** One choice of the picker: the number, what it was, the amount and the status (S12 screens). */
type Choice = {
  id: string;
  number: string;
  label: string;
  /** S16 AP11: null for a gift or a compensation from the store (no price shown). */
  amountUnits: number | null;
  status: string;
  tone: BadgeProps['tone'];
};

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; choices: Choice[] };

/**
 * The order or deposit a ticket is about (TK1): the customer's last 30, newest first, with the
 * one named in the link (`?order=`, `?deposit=`) added when it is older. Only the customer's own
 * records are listed; the API refuses any other (`TICKET_LINK_INVALID`).
 */
export function LinkPicker({
  kind,
  value,
  prefill,
  invalid,
  disabled,
  onChange,
}: {
  kind: 'order' | 'deposit';
  value: string | null;
  prefill: string | null;
  invalid: boolean;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const labelId = useId();

  const load = useCallback(async () => {
    const choices = kind === 'order' ? await orderChoices(prefill) : await depositChoices(prefill);
    setState(choices ? { status: 'ready', choices } : { status: 'failed' });
  }, [kind, prefill]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  const title = t(kind === 'order' ? 'support.new.pickOrder' : 'support.new.pickDeposit');
  return (
    <fieldset className="flex flex-col gap-2" aria-labelledby={labelId} disabled={disabled}>
      <legend id={labelId} className="text-sm font-medium">
        {title}
      </legend>
      {state.status === 'loading' ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-16 w-full" />
          ))}
        </div>
      ) : state.status === 'failed' ? (
        <div className="flex flex-col gap-2">
          <FormAlert>{t('support.new.linksFailed')}</FormAlert>
          <Button
            type="button"
            variant="outline"
            size="xl"
            className="self-start"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('support.retry')}
          </Button>
        </div>
      ) : state.choices.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t(kind === 'order' ? 'support.new.noOrders' : 'support.new.noDeposits')}
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-invalid={invalid}
          className={`flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-lg border bg-surface ${invalid ? 'border-destructive-text' : 'border-border'}`}
        >
          {state.choices.map((choice) => (
            <label
              key={choice.id}
              className="flex min-h-16 cursor-pointer items-center gap-3 px-4 py-3 has-checked:bg-muted"
            >
              <input
                type="radio"
                name={`ticket-${kind}`}
                value={choice.id}
                checked={value === choice.id}
                onChange={() => onChange(choice.id)}
                className="size-5 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <bdi className="font-medium break-words">{choice.label}</bdi>
                <span className="text-xs text-muted-foreground">
                  <bdi dir="ltr">{choice.number}</bdi>
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {choice.amountUnits !== null && (
                  <bdi dir="ltr" className="text-sm font-bold tabular-nums">
                    {formatUsd(choice.amountUnits)}
                  </bdi>
                )}
                <Badge tone={choice.tone}>{choice.status}</Badge>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** The last 30 orders, and the prefilled one first when it is older; null when unreadable. */
async function orderChoices(prefill: string | null): Promise<Choice[] | null> {
  const page = await recentOrders();
  if (!page.ok) return null;
  const choices: Choice[] = page.data.items.map((order) => ({
    id: order.id,
    number: order.number,
    label: order.productNameAr,
    amountUnits: order.totalUsdUnits,
    status: stageText(order.stage),
    tone: STAGE_TONES[order.stage],
  }));
  if (prefill && !choices.some((choice) => choice.id === prefill)) {
    const order = await getOrder(prefill);
    if (order.ok) {
      choices.unshift({
        id: order.data.id,
        number: order.data.number,
        label: order.data.product.nameAr,
        amountUnits: order.data.totalUsdUnits,
        status: stageText(order.data.stage),
        tone: STAGE_TONES[order.data.stage],
      });
    }
  }
  return choices;
}

/** The last 30 deposits (both methods), and the prefilled one first when it is older. */
async function depositChoices(prefill: string | null): Promise<Choice[] | null> {
  const page = await recentDeposits();
  if (!page.ok) return null;
  const deposits = page.data.items;
  if (prefill && !deposits.some((deposit) => deposit.id === prefill)) {
    const deposit = await getDeposit(prefill);
    if (deposit.ok) deposits.unshift(deposit.data);
  }
  return deposits.map((deposit) => ({
    id: deposit.id,
    number: deposit.referenceCode,
    label: t(`deposits.methods.${deposit.method}`),
    amountUnits: deposit.declaredUsdUnits,
    status: statusText(deposit),
    tone: DEPOSIT_TONES[deposit.status],
  }));
}
