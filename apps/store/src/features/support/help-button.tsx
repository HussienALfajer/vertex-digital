'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { LifeBuoyIcon, LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/lib/i18n';
import { findOpenTicket } from './requests';

/**
 * "تحتاج مساعدة؟" on an order or a deposit page (S12 screens): opens the customer's ticket about
 * it that is not closed, or a new ticket of its type with it chosen. The tickets are read only on
 * the press; when they cannot be, the new ticket opens (the API names an open one if any).
 */
export function HelpButton({ link }: { link: { orderId: string } | { depositId: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    const found = await findOpenTicket(link);
    if (found.ok && found.data) {
      router.push(`/support/${found.data.id}`);
      return;
    }
    router.push(
      'orderId' in link
        ? `/support/new?category=order&order=${link.orderId}`
        : `/support/new?category=deposit&deposit=${link.depositId}`,
    );
  };

  return (
    <Button
      variant="ghost"
      size="xl"
      className="self-start px-3"
      disabled={busy}
      onClick={() => void open()}
    >
      {busy ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
      ) : (
        <LifeBuoyIcon aria-hidden="true" />
      )}
      {t('support.help')}
    </Button>
  );
}
