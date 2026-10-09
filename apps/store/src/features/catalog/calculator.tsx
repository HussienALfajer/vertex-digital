'use client';

import {
  CALCULATOR_MAX_TARGET,
  cheapestPackCombination,
  displaySypTotal,
  formatSyp,
  formatUsd,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { useState } from 'react';
import { t } from '@/lib/i18n';

import type { CalculatorPack } from './calculator-card';

/**
 * The calculator's body (rules CL2, CL3): the cheapest combination of packs reaching the target
 * amount, each line with "اشترِ" opening the buy box on that pack. Nothing is bought together
 * until S10's cart. Loaded when the calculator is first opened.
 */
export function Calculator({
  packs,
  onBuy,
}: {
  packs: CalculatorPack[];
  onBuy: (packId: string, count: number) => void;
}) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const target = /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null;
  const valid = target !== null && target >= 1 && target <= CALCULATOR_MAX_TARGET;
  const result = valid
    ? cheapestPackCombination(
        packs.map((pack) => ({
          id: pack.id,
          gameAmount: pack.gameAmount,
          priceUsdUnits: pack.priceUsdUnits,
        })),
        target,
      )
    : null;
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  const sypKnown = result?.lines.every((line) => byId.get(line.packId)?.priceSypUnits !== null);
  const totalSyp =
    result && sypKnown
      ? displaySypTotal(
          result.lines.map((line) => ({
            sypUnits: byId.get(line.packId)?.priceSypUnits ?? 0,
            count: line.count,
          })),
        )
      : null;

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <Field invalid={trimmed !== '' && !valid}>
        <FieldLabel>{t('calculator.target')}</FieldLabel>
        <Input
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          className="h-11 text-md"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <FieldDescription>{t('calculator.hint')}</FieldDescription>
        <FieldError match={trimmed !== '' && !valid}>
          {t('calculator.invalid', { max: CALCULATOR_MAX_TARGET.toLocaleString('en-US') })}
        </FieldError>
      </Field>
      {result && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <ul className="flex flex-col gap-2">
            {result.lines.map((line) => {
              const pack = byId.get(line.packId);
              if (!pack) return null;
              return (
                <li
                  key={line.packId}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-2 ps-3"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">
                      <bdi>{pack.nameAr}</bdi> × {line.count}
                    </span>
                    <bdi dir="ltr" className="text-end text-sm text-muted-foreground tabular-nums">
                      {formatUsd(pack.priceUsdUnits)}
                    </bdi>
                  </span>
                  <Button variant="outline" size="xl" onClick={() => onBuy(pack.id, line.count)}>
                    {t('calculator.buy')}
                  </Button>
                </li>
              );
            })}
          </ul>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t('calculator.totalAmount')}</dt>
              <dd className="font-bold tabular-nums">
                {result.totalAmount.toLocaleString('en-US')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t('calculator.totalPrice')}</dt>
              <dd className="flex flex-col items-end">
                <bdi dir="ltr" className="text-lg font-bold tabular-nums">
                  {formatUsd(result.totalUsdUnits)}
                </bdi>
                {totalSyp !== null && (
                  <span className="text-muted-foreground tabular-nums">
                    {t('catalog.price.syp', { amount: formatSyp(totalSyp) })}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {result.overshoot > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('calculator.overshoot', {
                amount: result.totalAmount.toLocaleString('en-US'),
                extra: result.overshoot.toLocaleString('en-US'),
              })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('calculator.separate')}</p>
        </div>
      )}
    </div>
  );
}
