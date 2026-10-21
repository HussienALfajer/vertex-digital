import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { StatementsPage } from '@/features/merchant-tools/statements-page';

export const metadata: Metadata = { title: tm('nav.statements'), robots: { index: false } };

/** S21 F38: read in the browser with the session cookie. */
export default function MerchantStatementsRoute() {
  return <StatementsPage />;
}
