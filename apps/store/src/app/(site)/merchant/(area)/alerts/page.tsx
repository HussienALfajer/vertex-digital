import type { Metadata } from 'next';
import { AlertsPage } from '@/features/merchant-tools/alerts-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.alerts'), robots: { index: false } };

/** S21 F37: read in the browser with the session cookie. */
export default function MerchantAlertsRoute() {
  return <AlertsPage />;
}
