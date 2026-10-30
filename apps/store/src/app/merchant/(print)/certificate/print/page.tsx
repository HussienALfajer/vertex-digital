import type { Metadata } from 'next';
import { CertificatePrintPage } from '@/features/merchant-tools/certificate-print-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('tier.certificate.title'), robots: { index: false } };

/**
 * S23 ID7: the certificate to print, outside the merchant area's frame; the layout's header and
 * footer are hidden here.
 */
export default function CertificatePrintRoute() {
  return <CertificatePrintPage />;
}
