'use client';

import { type CreditLimits, formatUsd } from '@vertex-digital/contracts';
import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { ltr } from '@/lib/format';
import { tcr } from './i18n';

/** `GET /api/credit-limits`: what the signed-in customer may still spend in the section. */
export function getCreditLimits(fetcher: typeof fetch = fetch) {
  return apiRequest<CreditLimits>('/api/credit-limits', { fetcher });
}

/**
 * S25 CL2, CS1, CS2: under a section pack's totals, what the customer may still spend today (and,
 * for cash, what of the balance a cash order may use now). Nothing while unknown or on a failed
 * read: the server decides at payment, and its refusal says the same.
 */
export function RemainingLimits({ cash, refresh }: { cash: boolean; refresh: number }) {
  const [limits, setLimits] = useState<CreditLimits | null>(null);
  useEffect(() => {
    let live = true;
    void refresh;
    void getCreditLimits().then((result) => {
      if (live && result.ok) setLimits(result.data);
    });
    return () => {
      live = false;
    };
  }, [refresh]);
  if (!limits) return null;
  const usd = (units: number) => ltr(formatUsd(units));
  return (
    <p className="text-sm text-muted-foreground" data-testid="credit-remaining">
      {cash
        ? tcr('limits.remainingCash', {
            cash: usd(limits.cashRemainingUsdUnits),
            eligible: usd(limits.cashEligibleUsdUnits),
          })
        : tcr('limits.remaining', { section: usd(limits.sectionRemainingUsdUnits) })}
    </p>
  );
}
