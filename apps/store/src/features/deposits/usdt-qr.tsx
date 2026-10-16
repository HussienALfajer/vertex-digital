'use client';

import type { DepositUsdt } from '@vertex-digital/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { t } from '@/lib/i18n';
import vertexMark from '../../../../../brand/logo/svg/vertex-mark-green.svg';
import { addressGroups } from './amounts';

type UsdtMethod = DepositUsdt['method'];

/**
 * Each network's own color (theme tokens `network-tron`, `network-bnb`), shown only as the frame's
 * top edge and a dot beside its name, so the customer sees at a glance which network the address
 * belongs to (brand/identity.md §6: an accent tints, never carries text).
 */
const NETWORK_ACCENTS: Record<UsdtMethod, { edge: string; dot: string }> = {
  usdt_trc20: { edge: 'border-t-network-tron', dot: 'bg-network-tron' },
  usdt_bep20: { edge: 'border-t-network-bnb', dot: 'bg-network-bnb' },
};

/** The mark's own proportions (its viewBox, 598.7 × 517.4). */
const MARK_RATIO = 517.4 / 598.7;

/**
 * The store's USDT address as a wallet reads it (S04 screens): a high-contrast QR on white in both
 * themes, the store's mark in its middle (level H recovers far more than the mark covers), framed
 * by the network's color with "USDT" and the network named above it. A tap opens it larger, with
 * the address in groups of four under it for a last visual check. The QR holds the address only:
 * exchanges read no amount from a QR, so the amount is always typed or pasted.
 */
export function UsdtQr({ address, method }: { address: string; method: UsdtMethod }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('deposits.usdt.qrEnlarge')}
        data-testid="usdt-qr"
        className={`flex w-fit flex-col items-center gap-3 self-center rounded-2xl border border-t-4 border-neutral-200 bg-white p-3 px-4 text-neutral-900 shadow-sm outline-none transition-shadow duration-150 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring ${NETWORK_ACCENTS[method].edge}`}
      >
        <NetworkLine method={method} />
        <QrCode address={address} size={192} />
        <span className="text-xs text-neutral-600">{t('deposits.usdt.qrTap')}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t('deposits.close')}>
          <DialogHeader>
            <DialogTitle>{t('deposits.usdt.qrTitle')}</DialogTitle>
            <DialogDescription>{t(`deposits.usdt.networkNote.${method}`)}</DialogDescription>
          </DialogHeader>
          <div
            className={`flex flex-col items-center gap-4 rounded-2xl border border-t-4 border-neutral-200 bg-white p-5 text-neutral-900 ${NETWORK_ACCENTS[method].edge}`}
          >
            <NetworkLine method={method} />
            <QrCode address={address} size={272} />
            <p
              dir="ltr"
              className="flex flex-wrap justify-center gap-x-2 gap-y-1 text-base font-medium tabular-nums"
            >
              {addressGroups(address).map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: groups repeat; the order is the key.
                <span key={index}>{group}</span>
              ))}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "USDT" and the network, as wallets and explorers write them, left to right. */
function NetworkLine({ method }: { method: UsdtMethod }) {
  return (
    <span dir="ltr" className="flex items-center gap-2 text-sm">
      <span className="font-bold">USDT</span>
      <span className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2 py-0.5 font-medium">
        <span aria-hidden="true" className={`size-2 rounded-full ${NETWORK_ACCENTS[method].dot}`} />
        {t(`deposits.usdt.networks.${method}`)}
      </span>
    </span>
  );
}

function QrCode({ address, size }: { address: string; size: number }) {
  const markWidth = Math.round(size * 0.22);
  return (
    <QRCodeSVG
      value={address}
      size={size}
      level="H"
      marginSize={0}
      // green-950 on the white frame, the darkest brand step (19:1): every wallet camera reads it.
      fgColor="currentColor"
      bgColor="transparent"
      className="text-green-950"
      imageSettings={{
        src: vertexMark.src,
        width: markWidth,
        height: Math.round(markWidth * MARK_RATIO),
        excavate: true,
      }}
      role="img"
      aria-label={t('deposits.usdt.qrLabel')}
    />
  );
}
