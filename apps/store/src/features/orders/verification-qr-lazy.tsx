'use client';

import dynamic from 'next/dynamic';

/**
 * The verification QR loaded on its own (S21 VF1), so a server-rendered receipt (the public
 * receipt page, the order page) ships the QR code only where one is shown.
 */
export const LazyVerificationQr = dynamic(
  () => import('./verification-qr').then((module) => module.VerificationQr),
  { ssr: false, loading: () => <span className="block size-30 bg-white" aria-hidden="true" /> },
);
