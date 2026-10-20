'use client';

import type {
  CustomerProfile,
  MerchantApplication,
  MerchantApplicationState,
} from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, MessageSquareTextIcon, StoreIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { getProfile } from '@/features/account/requests';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ApplicationForm } from './application-form';
import { draftOf, emptyDraft } from './form';
import { getMerchantApplication, withdrawMerchantApplication } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; profile: CustomerProfile; merchant: MerchantApplicationState };

/** The status chip's tone (brand §2: in progress info, waiting on the customer warning). */
const TONES = {
  under_review: 'info',
  info_requested: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
  withdrawn: 'neutral',
} as const;

/**
 * `/account/merchant` (S20 screens): the application's state and timeline, the four-step form
 * when the customer may apply (or must answer a request for information), the withdrawal. Read
 * in the browser with the session cookie, never cached.
 */
export function MerchantPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    const [profile, merchant] = await Promise.all([getProfile(), getMerchantApplication()]);
    if (!profile.ok && profile.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Faccount%2Fmerchant');
      return;
    }
    if (!profile.ok || !merchant.ok) return setState({ status: 'failed' });
    setState({ status: 'ready', profile: profile.data, merchant: merchant.data });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <MerchantSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('merchant.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('merchant.retry')}
          </Button>
        }
      />
    );
  }

  const { profile, merchant } = state;
  const application = merchant.application;
  const reload = () => {
    setApplying(false);
    void load();
  };

  if (profile.merchant) {
    return (
      <div className="flex flex-col gap-6">
        <Callout
          tone="info"
          icon={<StoreIcon />}
          title={t('merchant.state.merchant', { tradeName: profile.merchant.tradeName })}
          description={t('merchant.card.priceKind', {
            kind: t(`merchant.priceKinds.${profile.priceKind}`),
          })}
        />
        {application && <Timeline application={application} />}
      </div>
    );
  }

  const form = (initial: ReturnType<typeof emptyDraft>, mode: 'submit' | 'resubmit') =>
    merchant.termsVersionId ? (
      <Card>
        <ApplicationForm
          initial={initial}
          contactName={profile.name}
          termsVersionId={merchant.termsVersionId}
          mode={mode}
          onSent={reload}
        />
      </Card>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      {application && !(applying && merchant.canApply) && (
        <StatusCard application={application} merchant={merchant} onChanged={reload} />
      )}
      {application?.status === 'info_requested' && form(draftOf(application), 'resubmit')}
      {merchant.termsVersionId === null && !application && (
        <Callout tone="info" icon={<StoreIcon />} title={t('merchant.state.soon')} />
      )}
      {merchant.canApply &&
        (application && !applying ? (
          <Button size="xl" className="self-start" onClick={() => setApplying(true)}>
            {t('merchant.state.applyAgain')}
          </Button>
        ) : (
          form(emptyDraft(profile.phone), 'submit')
        ))}
      {application && <Timeline application={application} />}
    </div>
  );
}

/** The application's state in words, its message, and the withdrawal while it is open. */
function StatusCard({
  application,
  merchant,
  onChanged,
}: {
  application: MerchantApplication;
  merchant: MerchantApplicationState;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const open = application.status === 'under_review' || application.status === 'info_requested';

  async function withdraw() {
    setWithdrawing(true);
    const result = await withdrawMerchantApplication();
    setWithdrawing(false);
    setConfirmOpen(false);
    if (!result.ok) return setFailure(result.reason);
    onChanged();
  }

  return (
    <Card data-testid="merchant-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{application.tradeName}</h2>
        <Badge tone={TONES[application.status]}>
          {t(`merchant.statuses.${application.status}`)}
        </Badge>
      </div>
      <p className="text-base">
        {application.status === 'info_requested'
          ? t('merchant.state.info_requested', {
              date: formatDateTime(application.expiresAt ?? application.submittedAt),
            })
          : t(`merchant.state.${application.status}`)}
      </p>
      {application.adminMessage &&
        (application.status === 'info_requested' || application.status === 'rejected') && (
          <Callout
            tone={application.status === 'rejected' ? 'danger' : 'warning'}
            icon={<MessageSquareTextIcon />}
            title={
              application.status === 'rejected'
                ? t('merchant.state.rejectedReason', { reason: application.adminMessage })
                : t('merchant.state.adminMessage')
            }
            description={application.status === 'rejected' ? undefined : application.adminMessage}
          />
        )}
      {merchant.availableAt && (
        <p className="text-sm text-muted-foreground">
          {t('merchant.state.reapplyAt', { date: formatDateTime(merchant.availableAt) })}
        </p>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      {open && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            variant="outline"
            size="xl"
            className="self-start"
            onClick={() => setConfirmOpen(true)}
          >
            {t('merchant.state.withdraw')}
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('merchant.state.withdrawTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('merchant.state.withdrawBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="xl" />}>
                {t('merchant.state.cancel')}
              </AlertDialogClose>
              <Button
                variant="destructive"
                size="xl"
                disabled={withdrawing}
                onClick={() => void withdraw()}
              >
                {withdrawing
                  ? t('merchant.state.withdrawing')
                  : t('merchant.state.withdrawConfirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Card>
  );
}

/** The application's events, oldest first, with the admin's words where there are some. */
function Timeline({ application }: { application: MerchantApplication }) {
  return (
    <Card>
      <h2 className="text-lg font-bold">{t('merchant.timeline.title')}</h2>
      <ol className="flex flex-col gap-3">
        {application.events.map((event) => (
          <li key={`${event.event}-${event.createdAt}`} className="flex flex-col gap-0.5">
            <span className="font-medium">{t(`merchant.timeline.${event.event}`)}</span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatDateTime(event.createdAt)}
            </span>
            {event.message && <span className="text-sm">{event.message}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function MerchantSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-2/3" />
    </div>
  );
}
