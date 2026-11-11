import type { Metadata } from 'next';
import { DashboardPage } from '@/features/merchant-tools/dashboard-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.dashboard'), robots: { index: false } };

/** S21 F30: read in the browser with the session cookie. */
export default function MerchantDashboardRoute() {
  return <DashboardPage />;
}
