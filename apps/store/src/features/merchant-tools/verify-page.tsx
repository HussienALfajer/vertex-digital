import {
  type PublicVerification,
  type VerificationStage,
  verificationCodeSchema,
} from '@vertex-digital/contracts';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { Badge } from '@vertex-digital/ui/components/badge';
import { BadgeCheckIcon } from 'lucide-react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LocalTime } from '@/features/shares/local-time';
import { t } from '@/lib/i18n';
import { apiInternalUrl } from '@/lib/server-env';
import { tm } from './i18n';

/*
 * The public verification page of a receipt's QR (S21 VF2, VF3), read by the store's server on
 * every request with the visitor's address, so the API's 60 a minute per address counts the
 * visitor (as the share pages do, S10 SH5). Never cached here.
 */

class VerificationUnavailable extends Error {}

/** The order behind the code, or null for an unknown or malformed one. */
async function readVerification(code: string): Promise<PublicVerification | null> {
  if (!verificationCodeSchema.safeParse(code).success) return null;
  const visitor = (await headers()).get('x-forwarded-for');
  const response = await fetch(`${apiInternalUrl()}/api/verify/${code}`, {
    cache: 'no-store',
    headers: { accept: 'application/json', ...(visitor && { 'x-forwarded-for': visitor }) },
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new VerificationUnavailable(`GET /api/verify answered ${response.status}`);
  return (await response.json()) as PublicVerification;
}

const STAGE_TONES = {
  processing: 'info',
  delivered: 'success',
  partially_delivered: 'warning',
  not_delivered: 'neutral',
  refunded: 'neutral',
} as const satisfies Record<VerificationStage, string>;

/**
 * VF2: "طلب حقيقي" with the order's facts in plain words; a merchant's order names the shop first
 * and "تم التحقق عبر VERTEX DIGITAL" small below it (decision 12). No price, code, name or link to
 * buy. VF3: an unknown code is the route's not-found view, "لم نعثر على هذا الطلب".
 */
export async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const page = await readVerification(code);
  if (!page) notFound();
  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        {page.issuer.kind === 'merchant' ? (
          <>
            <p className="text-xl font-bold break-words">
              <bdi>{page.issuer.tradeName}</bdi>
            </p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <VertexMark className="w-4" />
              {tm('verify.verifiedBy')}
            </p>
          </>
        ) : (
          <p className="flex items-center gap-2 text-accent-text">
            <VertexMark className="w-7" />
            <span className="text-base font-bold text-foreground" dir="ltr">
              {t('app.wordmark')}
            </span>
          </p>
        )}
      </header>
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-lg font-bold text-status-success-foreground">
          <BadgeCheckIcon className="size-6" aria-hidden="true" />
          {tm('verify.real')}
        </p>
        <Badge tone={STAGE_TONES[page.stage]}>{tm(`print.stages.${page.stage}`)}</Badge>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <Line label={tm('verify.order')}>
          <bdi dir="ltr" className="font-medium">
            {page.orderNumber}
          </bdi>
        </Line>
        <Line label={tm('verify.game')}>{page.game.nameAr}</Line>
        <Line label={tm('verify.pack')}>
          <bdi>{page.product.nameAr}</bdi>
        </Line>
        <Line label={tm('verify.quantity')}>{page.quantity}</Line>
        <Line label={tm('verify.delivered')}>{page.deliveredQuantity}</Line>
        {page.fields.map((field) => (
          <Line key={field.labelAr} label={field.labelAr}>
            <bdi dir="ltr">{field.value}</bdi>
          </Line>
        ))}
        <Line label={tm('verify.createdAt')}>
          <LocalTime iso={page.createdAt} />
        </Line>
        {page.deliveredAt && (
          <Line label={tm('verify.deliveredAt')}>
            <LocalTime iso={page.deliveredAt} />
          </Line>
        )}
      </dl>
    </article>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
