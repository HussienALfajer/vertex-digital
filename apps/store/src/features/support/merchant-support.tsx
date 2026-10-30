'use client';

import type { MerchantTierSummary } from '@vertex-digital/contracts';
import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DirectContact } from '@/features/merchant-tools/direct-contact';
import { getTier } from '@/features/merchant-tools/requests';
import { useCustomer } from '@/features/purchase/session';
import { replyPromiseText } from './labels';

/**
 * S23 OP3, OP4 on the support pages: for a merchant whose tier promises a reply, "نرد عادةً خلال
 * …", and for a Diamond merchant the direct contact buttons. Read in the browser; nothing for a
 * customer, a merchant without either, or a failed read.
 */
export function MerchantSupport() {
  const customer = useCustomer();
  const [tier, setTier] = useState<MerchantTierSummary | null>(null);
  const merchant = customer.status === 'signedIn' && customer.merchant;

  useEffect(() => {
    if (!merchant) return;
    let live = true;
    void getTier().then((result) => {
      if (live && result.ok) setTier(result.data);
    });
    return () => {
      live = false;
    };
  }, [merchant]);

  const minutes = tier?.privileges.supportReplyMinutes ?? null;
  if (!tier || (minutes === null && !tier.contact)) return null;
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      data-testid="merchant-support"
    >
      {minutes !== null && (
        <p className="flex items-center gap-2 text-md font-medium">
          <ClockIcon className="size-5 shrink-0" aria-hidden="true" />
          {replyPromiseText(minutes)}
        </p>
      )}
      <DirectContact contact={tier.contact} />
    </div>
  );
}
