import { certificateCodeSchema, type PublicCertificate } from '@vertex-digital/contracts';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { TierBadge, tierSurfaceVariants } from '@vertex-digital/ui/components/tier-badge';
import { BadgeCheckIcon, CircleOffIcon } from 'lucide-react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LocalDate } from '@/features/shares/local-time';
import { t } from '@/lib/i18n';
import { API_READ_TIMEOUT_MS, apiInternalUrl } from '@/lib/server-env';
import { tm } from './i18n';
import { approvedLine } from './tier-parts';

/*
 * The public page of a merchant certificate's QR (S23 ID7), read by the store's server on every
 * request with the visitor's address, so the API's 60 a minute per address counts the visitor (as
 * the verification page does). Never cached here.
 */

class CertificateUnavailable extends Error {}

/** The certificate behind the code, or null for an unknown or malformed one. */
async function readCertificate(code: string): Promise<PublicCertificate | null> {
  if (!certificateCodeSchema.safeParse(code).success) return null;
  const visitor = (await headers()).get('x-forwarded-for');
  const response = await fetch(`${apiInternalUrl()}/api/certificates/${code}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(visitor && { 'x-forwarded-for': visitor }) },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CertificateUnavailable(`GET /api/certificates answered ${response.status}`);
  }
  return (await response.json()) as PublicCertificate;
}

/**
 * ID7: the trade name, city, governorate and the current tier with "منذ"; never a phone, address,
 * price or email. A revoked merchant: "هذا المتجر لم يعد تاجراً معتمداً لدى Vertex Digital". An
 * unknown code is the route's neutral not-found view.
 */
export async function CertificatePublicPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const certificate = await readCertificate(code);
  if (!certificate) notFound();
  if (certificate.status === 'revoked') {
    return (
      <article
        className="flex flex-col items-center gap-4 rounded-xl border border-border bg-surface p-6 text-center"
        data-testid="certificate-public"
      >
        <CircleOffIcon className="size-10 text-muted-foreground" aria-hidden="true" />
        <p className="text-lg font-bold">{tm('tier.public.revoked')}</p>
      </article>
    );
  }
  return (
    <article
      className={`flex flex-col items-center gap-4 rounded-xl p-6 text-center ${tierSurfaceVariants({ tier: certificate.tier })}`}
      data-testid="certificate-public"
    >
      <p className="flex items-center gap-2 text-accent-text">
        <VertexMark className="w-7" />
        <span className="text-base font-bold text-foreground" dir="ltr">
          {t('app.wordmark')}
        </span>
      </p>
      <p className="flex items-center gap-2 text-lg font-bold text-status-success-foreground">
        <BadgeCheckIcon className="size-6" aria-hidden="true" />
        {tm('tier.public.active')}
      </p>
      <p className="text-2xl font-bold break-words">
        <bdi>{certificate.tradeName}</bdi>
      </p>
      <p className="text-muted-foreground">
        {tm('tier.public.place', {
          city: certificate.city,
          governorate: t(`merchant.governorates.${certificate.governorate}`),
        })}
      </p>
      {certificate.tier === 'bronze' ? (
        <p className="font-medium">{approvedLine('bronze', true)}</p>
      ) : (
        <TierBadge tier={certificate.tier} size="lg" label={approvedLine(certificate.tier, true)} />
      )}
      <p className="text-sm text-muted-foreground">
        {tm('tier.public.since')}
        <LocalDate iso={certificate.since} />
      </p>
    </article>
  );
}
