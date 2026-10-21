import type { Metadata } from 'next';
import { BulkPage } from '@/features/merchant-tools/bulk-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.bulk'), robots: { index: false } };

/** S21 F33: read in the browser with the session cookie. */
export default function MerchantBulkRoute() {
  return <BulkPage />;
}
