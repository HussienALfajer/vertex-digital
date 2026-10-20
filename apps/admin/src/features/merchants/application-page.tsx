import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminCustomer,
  type AdminMerchantApplication,
  formatUsd,
  merchantMessageSchema,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  PageHeader,
  Skeleton,
  Textarea,
} from '@vertex-digital/ui';
import { ArrowRightIcon, CircleAlertIcon, PinIcon, UserRoundIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince, ltr } from '../../lib/format';
import { CHIP_TONES, statusChips } from '../customers/customer-labels';
import { customerQuery } from '../customers/customers.queries';
import { Picker } from '../pricing/picker';
import { APPLICATION_TONES } from './applications-page';
import { useListItems } from './merchant-dialogs';
import {
  applicationPhotoUrl,
  applicationQuery,
  useApproveApplication,
  useRejectApplication,
  useRequestApplicationInfo,
} from './merchants.queries';

type Decision = 'approve' | 'request_info' | 'reject';

/**
 * One merchant application (S20 MA4–MA8, screens): the form, the photo (opens large), the link as
 * text with a copy button, the events; beside it the customer's summary and signals (S12) with a
 * link to the profile; the decisions while it is under review (approve with a list and
 * re-authentication, request information, reject; message and reason required).
 */
export function ApplicationPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const application = useQuery(applicationQuery(id));
  const [decision, setDecision] = useState<Decision | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);

  const back = (
    <Button variant="outline" render={<Link to="/merchants/applications" />}>
      <ArrowRightIcon className="rtl:-scale-x-100" />
      {t('merchants.application.back')}
    </Button>
  );
  if (application.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (application.isError) {
    return (
      <>
        <PageHeader title={t('merchants.application.title')} actions={back} />
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, application.error)}
          action={
            <Button variant="outline" onClick={() => application.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      </>
    );
  }

  const data = application.data;
  const reviewing = data.status === 'under_review';
  return (
    <>
      <PageHeader
        title={data.tradeName}
        description={t('merchants.application.submitted', {
          date: formatDateTime(data.submittedAt),
        })}
        actions={back}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={APPLICATION_TONES[data.status]}>
          {t(`merchants.statuses.${data.status}`)}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {t('merchants.application.terms', { version: data.termsVersion })}
        </span>
        {data.approvedPriceList && (
          <Badge tone="gold">
            {t('merchants.application.approvedList', { name: data.approvedPriceList.name })}
          </Badge>
        )}
      </div>
      {reviewing && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDecision('approve')}>{t('merchants.decisions.approve')}</Button>
          <Button variant="outline" onClick={() => setDecision('request_info')}>
            {t('merchants.decisions.request_info')}
          </Button>
          <Button variant="destructive" onClick={() => setDecision('reject')}>
            {t('merchants.decisions.reject')}
          </Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <FormCard application={data} onPhoto={() => setPhotoOpen(true)} />
          <EventsCard application={data} />
        </div>
        <CustomerCard application={data} />
      </div>
      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        {decision === 'approve' && <ApproveDialog id={id} onDone={() => setDecision(null)} />}
        {(decision === 'request_info' || decision === 'reject') && (
          <MessageDialog id={id} decision={decision} onDone={() => setDecision(null)} />
        )}
      </Dialog>
      <Dialog open={photoOpen} onOpenChange={setPhotoOpen}>
        {photoOpen && (
          <DialogContent closeLabel={t('common.close')} className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{t('merchants.fields.shopPhoto')}</DialogTitle>
            </DialogHeader>
            <img
              src={applicationPhotoUrl(id)}
              alt={t('merchants.fields.shopPhoto')}
              className="max-h-[75vh] w-full rounded-lg object-contain"
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function FormCard({
  application,
  onPhoto,
}: {
  application: AdminMerchantApplication;
  onPhoto: () => void;
}) {
  const { t } = useTranslation();
  const interests = application.productInterests
    .map((value) => t(`merchants.interests.${value}`))
    .join('، ');
  const channels = application.salesChannels
    .map((value) => t(`merchants.channels.${value}`))
    .join('، ');
  return (
    <Card className="gap-4">
      <CardTitle>{t('merchants.application.form')}</CardTitle>
      {application.adminMessage && (
        <p className="rounded-md bg-status-warning px-3 py-2 text-sm text-status-warning-foreground">
          {application.adminMessage}
        </p>
      )}
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label={t('merchants.fields.activity')}>
          {application.activity === 'other'
            ? application.activityOther
            : t(`merchants.activities.${application.activity}`)}
        </Fact>
        <Fact label={t('merchants.fields.yearsInBusiness')}>
          {t(`merchants.years.${application.yearsInBusiness}`)}
        </Fact>
        <Fact label={t('merchants.fields.governorate')}>
          {t(`merchants.governorates.${application.governorate}`)}
        </Fact>
        <Fact label={t('merchants.fields.city')}>{application.city}</Fact>
        <Fact label={t('merchants.fields.streetAddress')}>{application.streetAddress}</Fact>
        <Fact label={t('merchants.fields.whatsapp')}>
          <span className="flex items-center gap-2">
            <bdi dir="ltr">{application.whatsapp}</bdi>
            <CopyButton value={application.whatsapp} label={t('merchants.fields.whatsapp')} />
          </span>
        </Fact>
        <Fact label={t('merchants.fields.telegramUsername')}>
          {application.telegramUsername ? (
            <bdi dir="ltr">@{application.telegramUsername}</bdi>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label={t('merchants.fields.monthlyVolume')}>
          {t(`merchants.volumes.${application.monthlyVolume}`)}
        </Fact>
        <Fact label={t('merchants.fields.productInterests')}>{interests}</Fact>
        <Fact label={t('merchants.fields.salesChannels')}>{channels}</Fact>
        <Fact label={t('merchants.fields.heardFrom')}>
          {application.heardFrom ? t(`merchants.heard.${application.heardFrom}`) : '—'}
        </Fact>
        <Fact label={t('merchants.fields.shopLink')}>
          {application.shopLink ? (
            // Shown as text, never a link (Abuse: a malicious shop link).
            <span className="flex items-center gap-2">
              <bdi dir="ltr" className="break-all">
                {application.shopLink}
              </bdi>
              <CopyButton value={application.shopLink} label={t('merchants.fields.shopLink')} />
            </span>
          ) : (
            '—'
          )}
        </Fact>
      </dl>
      {application.shopPhotoFileId && (
        <button
          type="button"
          className="w-fit rounded-lg border border-border"
          aria-label={t('merchants.application.openPhoto')}
          onClick={onPhoto}
        >
          <img
            src={applicationPhotoUrl(application.id)}
            alt={t('merchants.fields.shopPhoto')}
            className="h-40 w-auto rounded-lg object-cover"
          />
        </button>
      )}
    </Card>
  );
}

function EventsCard({ application }: { application: AdminMerchantApplication }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-4">
      <CardTitle>{t('merchants.application.events')}</CardTitle>
      <ol className="flex flex-col gap-3">
        {application.events.map((event) => (
          <li key={`${event.event}-${event.createdAt}`} className="flex flex-col gap-0.5">
            <span className="font-medium">{t(`merchants.events.${event.event}`)}</span>
            <span className="text-sm text-muted-foreground">{formatDateTime(event.createdAt)}</span>
            {event.message && <span className="text-sm">{event.message}</span>}
          </li>
        ))}
      </ol>
      {application.earlier.length > 0 && (
        <>
          <CardTitle>{t('merchants.application.earlier')}</CardTitle>
          <ul className="flex flex-col gap-2">
            {application.earlier.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  to="/merchants/applications/$id"
                  params={{ id: item.id }}
                  className="underline-offset-4 hover:underline"
                >
                  {formatDateTime(item.submittedAt)}
                </Link>
                <Badge tone={APPLICATION_TONES[item.status]}>
                  {t(`merchants.statuses.${item.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** The customer's summary and signals beside the form (S12), read from the profile. */
function CustomerCard({ application }: { application: AdminMerchantApplication }) {
  const { t } = useTranslation();
  const profile = useQuery(customerQuery(application.customer.id));
  return (
    <Card className="gap-4 self-start">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>{application.customer.name}</CardTitle>
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/customers/$id" params={{ id: application.customer.id }} />}
        >
          <UserRoundIcon />
          {t('merchants.application.profile')}
        </Button>
      </div>
      <bdi dir="ltr" className="text-sm text-muted-foreground">
        {application.customer.email}
      </bdi>
      {profile.isPending && <Skeleton className="h-40 w-full" />}
      {profile.isError && <FormAlert>{errorMessage(t, profile.error)}</FormAlert>}
      {profile.isSuccess && <CustomerFacts customer={profile.data} application={application} />}
    </Card>
  );
}

function CustomerFacts({
  customer,
  application,
}: {
  customer: AdminCustomer;
  application: AdminMerchantApplication;
}) {
  const { t } = useTranslation();
  const chips = statusChips(customer.status, customer.isTest);
  const signals = customer.signals.sharedPhone.count + customer.signals.sharedIp.count;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <Badge key={chip} tone={CHIP_TONES[chip]}>
            {t(`customers.chips.${chip}`)}
          </Badge>
        ))}
        {!customer.emailVerified && <Badge tone="warning">{t('merchants.flags.unverified')}</Badge>}
        {signals > 0 && (
          <Badge tone="warning">{t('merchants.flags.signals', { count: signals })}</Badge>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Fact label={t('merchants.customer.since')}>
          <span title={formatDateTime(customer.createdAt)}>{formatSince(customer.createdAt)}</span>
        </Fact>
        <Fact label={t('merchants.customer.balance')}>
          <bdi dir="ltr">{formatUsd(customer.balanceUnits)}</bdi>
        </Fact>
        <Fact label={t('merchants.customer.deposits')}>
          {t('merchants.customer.amountCount', {
            count: customer.counts.creditedDeposits,
            amount: ltr(formatUsd(customer.counts.creditedTotalUsdUnits)),
          })}
        </Fact>
        <Fact label={t('merchants.customer.orders')}>
          {t('merchants.customer.amountCount', {
            count: customer.counts.deliveredOrders,
            amount: ltr(formatUsd(customer.counts.deliveredTotalUsdUnits)),
          })}
        </Fact>
        <Fact label={t('merchants.customer.phone')}>
          <span className="flex flex-col">
            <bdi dir="ltr">{customer.phone}</bdi>
            {customer.phone !== application.whatsapp && (
              <span className="text-xs text-muted-foreground">
                {t('merchants.customer.phoneDiffers')}
              </span>
            )}
          </span>
        </Fact>
      </dl>
      {customer.pinnedNote && (
        <p className="flex items-start gap-2 rounded-md bg-status-gold px-3 py-2 text-sm text-status-gold-foreground">
          <PinIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{customer.pinnedNote.body}</span>
        </p>
      )}
    </>
  );
}

/** MA5: the list (wholesale by default), then re-authentication. */
function ApproveDialog({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const approve = useApproveApplication(id);
  const items = useListItems();
  const [listId, setListId] = useState<string>(ROOT_PRICE_LIST_IDS.wholesale);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    try {
      await approve.mutateAsync(listId === ROOT_PRICE_LIST_IDS.wholesale ? undefined : listId);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.decisions.approveTitle')}</DialogTitle>
        <DialogDescription>{t('merchants.decisions.approveDescription')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel render={<span />}>{t('merchants.fields.priceList')}</FieldLabel>
          <Picker
            label={t('merchants.fields.priceList')}
            items={items}
            value={listId}
            onChange={setListId}
          />
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={approve.isPending}>
            {t('merchants.decisions.approve')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** MA4: the message (information requested) or reason (rejection) the customer reads. */
function MessageDialog({
  id,
  decision,
  onDone,
}: {
  id: string;
  decision: 'request_info' | 'reject';
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const requestInfo = useRequestApplicationInfo(id);
  const reject = useRejectApplication(id);
  const mutation = decision === 'reject' ? reject : requestInfo;
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = merchantMessageSchema.safeParse(
      String(new FormData(event.currentTarget).get('message') ?? ''),
    );
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await mutation.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t(`merchants.decisions.${decision}Title`)}</DialogTitle>
        <DialogDescription>{t(`merchants.decisions.${decision}Description`)}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t(`merchants.decisions.${decision}Field`)}</FieldLabel>
          <Textarea name="message" rows={4} maxLength={500} />
          <FieldError match={invalid}>{t('merchants.validation.message')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button
            type="submit"
            variant={decision === 'reject' ? 'destructive' : 'primary'}
            disabled={mutation.isPending}
          >
            {t(`merchants.decisions.${decision}`)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
