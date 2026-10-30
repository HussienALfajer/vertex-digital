'use client';

import { certificatePath, type MerchantCertificate } from '@vertex-digital/contracts';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { TierIcon } from '@vertex-digital/ui/components/tier-badge';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback } from 'react';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { getCertificate } from './requests';
import { approvedLine } from './tier-parts';

/**
 * `/merchant/certificate/print` (S23 ID7): the certificate on A4 landscape, printed by the browser:
 * the trade name, city and governorate, "تاجر ذهبي معتمد" (Bronze "تاجر معتمد"), since when, the
 * print date, the Vertex mark and the QR of the certificate's public page. Black on white, the
 * tier's icon included (sand on white fails contrast, `brand/identity.md` §2).
 */
export function CertificatePrintPage() {
  const read = useCallback(() => getCertificate(), []);
  const { state, reload } = useMerchantRead(read);
  return (
    <DocumentPrintFrame
      back={{ href: '/merchant/tier', label: tm('tier.certificate.back') }}
      ready={state.status === 'ready'}
      orientation="landscape"
    >
      {state.status === 'ready' ? (
        <CertificateDocument certificate={state.data} />
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<Skeleton className="aspect-[297/210] w-full" />}
        />
      )}
    </DocumentPrintFrame>
  );
}

function CertificateDocument({ certificate }: { certificate: MerchantCertificate }) {
  const url = `${window.location.origin}${certificatePath(certificate.code)}`;
  return (
    <article
      data-testid="certificate-document"
      className="flex aspect-[297/210] w-full flex-col items-center justify-between gap-4 border-4 border-double border-neutral-950 bg-white p-10 text-center text-neutral-950"
    >
      <header className="flex flex-col items-center gap-2">
        <VertexMark className="w-14" />
        <p className="text-base font-bold" dir="ltr">
          {t('app.wordmark')}
        </p>
        <h1 className="text-3xl font-bold">{tm('tier.certificate.title')}</h1>
      </header>
      <div className="flex flex-col items-center gap-3">
        <p className="text-lg">{tm('tier.certificate.intro')}</p>
        <p className="text-4xl font-bold break-words">
          <bdi>{certificate.tradeName}</bdi>
        </p>
        <p className="text-lg">
          {tm('tier.public.place', {
            city: certificate.city,
            governorate: t(`merchant.governorates.${certificate.governorate}`),
          })}
        </p>
        <p className="flex items-center gap-2 text-2xl font-bold">
          {certificate.tier !== 'bronze' && (
            <TierIcon tier={certificate.tier} className="size-8 text-neutral-950" />
          )}
          {approvedLine(certificate.tier, true)}
        </p>
        <p>{tm('tier.certificate.since', { date: formatDate(certificate.since) })}</p>
      </div>
      <footer className="flex w-full items-end justify-between gap-6">
        <p className="text-sm">
          {tm('tier.certificate.printed', { date: formatDate(new Date().toISOString()) })}
        </p>
        <div className="flex flex-col items-center gap-1">
          <QRCodeSVG
            value={url}
            size={128}
            level="M"
            marginSize={4}
            bgColor="white"
            fgColor="black"
            role="img"
            aria-label={tm('tier.certificate.scan')}
          />
          <p className="text-xs">{tm('tier.certificate.scan')}</p>
        </div>
      </footer>
    </article>
  );
}
