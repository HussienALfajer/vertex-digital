import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { PosPage } from '@/features/merchant-tools/pos-page';

export const metadata: Metadata = { title: tm('nav.pos'), robots: { index: false } };

/** S21 F32: read in the browser with the session cookie. */
export default function MerchantPosRoute() {
  return <PosPage />;
}
