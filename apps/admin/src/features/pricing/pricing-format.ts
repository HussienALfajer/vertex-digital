import { BASIS_POINTS, CURRENCY_SCALE, type MarginRuleValues } from '@vertex-digital/contracts';

/*
 * The rule form's and the calculator's typed values: a percent with up to 2 decimals in basis
 * points, and a cost in USD units to the micro-dollar (supplier costs can be sub-cent, PR3).
 */

const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const COST_PATTERN = /^\d{1,5}(\.\d{1,6})?$/;

/** `10` → 1000, `12.5` → 1250 (rule PR1: 0–100%); null when it is not such a percent. */
export function parsePercentBp(text: string): number | null {
  const value = text.trim();
  if (!PERCENT_PATTERN.test(value)) return null;
  const [whole = '0', decimals = ''] = value.split('.');
  const bp = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return bp <= BASIS_POINTS ? bp : null;
}

/** 1000 → `10`, 1250 → `12.5`, 25 → `0.25`: the inverse of `parsePercentBp`, without the sign. */
export function formatPercentBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const decimals = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return decimals ? `${whole}.${decimals}` : String(whole);
}

/** `0.8875` → 887,500 USD units; null when it is not dollars with at most 6 decimals. */
export function parseCostUsd(text: string): number | null {
  const value = text.trim();
  if (!COST_PATTERN.test(value)) return null;
  const [whole = '0', decimals = ''] = value.split('.');
  return Number(whole) * CURRENCY_SCALE.USD + Number(decimals.padEnd(6, '0'));
}

/** A rule's values as the form shows them: percent, then dollars with 2 decimals. */
export function ruleTexts(rule: MarginRuleValues): {
  percent: string;
  fixed: string;
  minimum: string;
} {
  const dollars = (units: number) => (units / CURRENCY_SCALE.USD).toFixed(2);
  return {
    percent: formatPercentBp(rule.percentBp),
    fixed: dollars(rule.fixedUsdUnits),
    minimum: dollars(rule.minMarginUsdUnits),
  };
}
