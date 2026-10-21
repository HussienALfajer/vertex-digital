import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { ReceiptPage } from '@/features/merchant-tools/receipt-page';

export const metadata: Metadata = { title: tm('nav.receipt'), robots: { index: false } };

/** S21 BR3: read in the browser with the session cookie. */
export default function MerchantReceiptRoute() {
  return <ReceiptPage />;
}
