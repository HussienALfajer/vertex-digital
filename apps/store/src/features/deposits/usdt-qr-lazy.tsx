'use client';

import dynamic from 'next/dynamic';

/**
 * The USDT QR loaded only with a USDT deposit awaiting its transfer (audit A02-31): `qrcode.react`
 * stays out of the deposit page's chunk for Sham Cash and for every closed deposit. The
 * placeholder keeps the frame's size, so nothing under it moves when it arrives.
 */
export const LazyUsdtQr = dynamic(() => import('./usdt-qr').then((module) => module.UsdtQr), {
  ssr: false,
  loading: () => (
    <span
      className="block h-[17.75rem] w-[14.5rem] self-center rounded-2xl bg-white"
      aria-hidden="true"
    />
  ),
});
