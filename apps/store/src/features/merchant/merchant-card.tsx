'use client';

import type { CustomerProfile, MerchantApplicationState } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card, CardDescription, CardTitle } from '@vertex-digital/ui/components/card';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { FileSignatureIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { getMerchantApplication } from './requests';

const TermsSheet = dynamic(() => import('./terms-sheet').then((module) => module.TermsSheet));

/**
 * The account page's merchant card (S20 screens): for a customer, the invitation to apply ("قريباً"
 * before the first merchant terms, MT1) or the application's status; for a merchant, the trade
 * name and the price kind, and until the terms are accepted (MT2) a banner opening the sheet.
 */
export function MerchantCard({
  profile,
  onTermsAccepted,
}: {
  profile: CustomerProfile;
  onTermsAccepted: () => void;
}) {
  const [state, setState] = useState<MerchantApplicationState | null | 'failed'>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const merchant = profile.merchant;

  useEffect(() => {
    if (merchant) return;
    void getMerchantApplication().then((result) => setState(result.ok ? result.data : 'failed'));
  }, [merchant]);

  if (merchant) {
    return (
      <Card data-testid="merchant-card">
        <CardTitle>{t('merchant.card.merchant', { tradeName: merchant.tradeName })}</CardTitle>
        <CardDescription>
          {t('merchant.card.priceKind', { kind: t(`merchant.priceKinds.${profile.priceKind}`) })}
        </CardDescription>
        {!merchant.termsAccepted && (
          <>
            <Callout
              tone="warning"
              icon={<FileSignatureIcon />}
              title={t('merchant.card.termsBanner')}
              action={
                <Button size="xl" onClick={() => setSheetOpen(true)}>
                  {t('merchant.card.termsAction')}
                </Button>
              }
            />
            {sheetOpen && (
              <TermsSheet
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                onAccepted={onTermsAccepted}
              />
            )}
          </>
        )}
      </Card>
    );
  }
  if (state === 'failed') return null;
  if (state === null) return <Skeleton className="h-28 w-full" aria-hidden="true" />;
  const application = state.application;
  const open = application && ['under_review', 'info_requested'].includes(application.status);
  return (
    <Card data-testid="merchant-card">
      <CardTitle>{t('merchant.card.title')}</CardTitle>
      {state.termsVersionId === null && !application ? (
        <CardDescription>{t('merchant.card.soonHint')}</CardDescription>
      ) : open && application ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('merchant.card.status')}</span>
          <Badge tone={application.status === 'info_requested' ? 'warning' : 'info'}>
            {t(`merchant.statuses.${application.status}`)}
          </Badge>
        </div>
      ) : (
        <CardDescription>{t('merchant.card.apply')}</CardDescription>
      )}
      {(state.termsVersionId !== null || application) && (
        <Button
          variant={open ? 'outline' : 'primary'}
          size="xl"
          className="self-start"
          render={<Link href="/account/merchant" prefetch={false} />}
        >
          {open || !state.canApply ? t('merchant.card.open') : t('merchant.card.applyAction')}
        </Button>
      )}
    </Card>
  );
}
