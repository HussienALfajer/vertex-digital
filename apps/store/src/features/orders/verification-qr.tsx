'use client';

import { verificationPath } from '@vertex-digital/contracts';
import { QRCodeSVG } from 'qrcode.react';

/**
 * S21 VF1: the receipt's verification QR, black on white with its four-module quiet zone in both
 * themes and on paper. It holds the store's verification URL only: never a price or a code.
 */
export function VerificationQr({
  code,
  origin,
  size = 120,
  label,
}: {
  code: string;
  /** The store's origin; the browser's own when omitted. */
  origin?: string;
  size?: number;
  label: string;
}) {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return (
    <QRCodeSVG
      value={`${base}${verificationPath(code)}`}
      size={size}
      level="M"
      marginSize={4}
      bgColor="white"
      fgColor="black"
      role="img"
      aria-label={label}
      className="shrink-0"
    />
  );
}
