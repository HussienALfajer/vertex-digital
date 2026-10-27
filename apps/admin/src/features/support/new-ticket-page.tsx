import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  adminCreateTicketSchema,
  formatUsd,
  TICKET_CATEGORIES,
  type TicketCategory,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArchiveIcon, ArrowRightIcon, CircleAlertIcon, UserRoundSearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ReadFailure } from '../../components/read-failure';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDate, ltr } from '../../lib/format';
import { useIdempotentRequest } from '../../lib/idempotency';
import { customerQuery } from '../customers/customers.queries';
import { ImagePicker } from './image-picker';
import { linkDepositsQuery, linkOrdersQuery, useOpenTicket } from './support.queries';

type Errors = Partial<Record<'link' | 'subject' | 'body', boolean>>;

/**
 * "تذكرة جديدة" (S12 TK2), from a customer's profile: the type, for an order or a deposit a
 * picker of that customer's last 30, the subject, the message and up to 3 images. The ticket
 * starts `answered` and the customer is notified; the values stay on an error.
 */
export function NewTicketPage({ customerId }: { customerId?: string }) {
  const { t } = useTranslation();
  if (!customerId) {
    return (
      <>
        <PageHeader title={t('support.new.title')} />
        <EmptyState
          icon={<UserRoundSearchIcon />}
          title={t('support.new.noCustomer')}
          action={
            <Button variant="outline" render={<Link to="/customers" />}>
              {t('support.new.toCustomers')}
            </Button>
          }
        />
      </>
    );
  }
  return <NewTicketForm customerId={customerId} />;
}

function NewTicketForm({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const customer = useQuery(customerQuery(customerId));
  const open = useOpenTicket();
  const send = useIdempotentRequest();
  const [category, setCategory] = useState<TicketCategory>('order');
  const [linkId, setLinkId] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<unknown>(null);

  const back = (
    <Button
      variant="ghost"
      render={<Link to="/customers/$id" params={{ id: customerId }} search={{ tab: 'tickets' }} />}
    >
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {customer.data?.name ?? t('customers.back')}
    </Button>
  );

  if (customer.isPending) {
    return (
      <>
        <PageHeader title={t('support.new.title')} actions={back} />
        <Skeleton className="h-96 w-full" aria-hidden="true" />
      </>
    );
  }
  if (customer.isError) {
    return (
      <>
        <PageHeader title={t('support.new.title')} actions={back} />
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, customer.error)}
          action={
            <Button variant="outline" onClick={() => customer.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      </>
    );
  }

  // TK10 (audit A07-48): an archived customer gets no ticket; the way back is the profile.
  if (customer.data.status === 'archived') {
    return (
      <>
        <PageHeader title={t('support.new.title')} actions={back} />
        <EmptyState
          icon={<ArchiveIcon />}
          title={t('support.new.archivedTitle')}
          description={t('support.new.archivedBody')}
          action={
            <Button
              variant="outline"
              render={<Link to="/customers/$id" params={{ id: customerId }} />}
            >
              {t('support.new.toProfile')}
            </Button>
          }
        />
      </>
    );
  }

  const categories = TICKET_CATEGORIES.map((item) => ({
    value: item,
    label: t(`support.categories.${item}`),
  }));
  const existing =
    failure instanceof ApiError && failure.code === 'TICKET_ALREADY_OPEN'
      ? (failure.details as { ticketId?: string } | undefined)?.ticketId
      : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (open.isPending) return;
    setFailure(null);
    const input = {
      customerId,
      category,
      orderId: category === 'order' ? (linkId ?? undefined) : undefined,
      depositId: category === 'deposit' ? (linkId ?? undefined) : undefined,
      subject,
      body,
    };
    const parsed = adminCreateTicketSchema.safeParse(input);
    const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
    const linkMissing = (category === 'order' || category === 'deposit') && !linkId;
    setErrors({ link: linkMissing, subject: paths.has('subject'), body: paths.has('body') });
    if (!parsed.success || linkMissing) return focusInvalid();
    const signature = {
      ...input,
      files: files.map((file) => [file.name, file.size, file.lastModified]),
    };
    try {
      const ticket = await send(signature, (key) => open.mutateAsync({ body: input, files, key }));
      await navigate({ to: '/support/$id', params: { id: ticket.id } });
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <>
      <PageHeader
        title={t('support.new.title')}
        description={t('support.new.subtitle', { name: customer.data.name })}
        actions={back}
      />
      <Card className="max-w-2xl">
        <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel>{t('support.new.category')}</FieldLabel>
            <Select
              items={categories}
              value={category}
              onValueChange={(value) => {
                setCategory((value ?? 'order') as TicketCategory);
                setLinkId(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {category === 'order' && (
            <OrderPicker
              customerId={customerId}
              value={linkId}
              onChange={setLinkId}
              invalid={!!errors.link}
            />
          )}
          {category === 'deposit' && (
            <DepositPicker
              customerId={customerId}
              value={linkId}
              onChange={setLinkId}
              invalid={!!errors.link}
            />
          )}
          <Field invalid={!!errors.subject}>
            <FieldLabel>{t('support.new.subject')}</FieldLabel>
            <Input
              name="subject"
              maxLength={120}
              autoComplete="off"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
            <FieldError match={!!errors.subject}>{t('support.new.subjectError')}</FieldError>
          </Field>
          <Field invalid={!!errors.body}>
            <FieldLabel>{t('support.new.body')}</FieldLabel>
            <Textarea
              name="body"
              rows={6}
              maxLength={2000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <FieldError match={!!errors.body}>{t('support.new.bodyError')}</FieldError>
          </Field>
          <ImagePicker files={files} onChange={setFiles} disabled={open.isPending} />
          <InvalidAlert show={!!(errors.link || errors.subject || errors.body)} />
          {failure !== null && (
            <div className="flex flex-col items-start gap-2">
              <FormAlert>{errorMessage(t, failure)}</FormAlert>
              {existing && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11"
                  render={<Link to="/support/$id" params={{ id: existing }} />}
                >
                  {t('support.new.existing')}
                </Button>
              )}
            </div>
          )}
          <Button type="submit" className="self-start" disabled={open.isPending}>
            {open.isPending ? t('support.new.submitting') : t('support.new.submit')}
          </Button>
        </form>
      </Card>
    </>
  );
}

interface PickerProps {
  customerId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  invalid: boolean;
}

/** The read a link picker's items come from. */
interface LinkRead {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/**
 * The order or deposit to link. A failed read shows inside the field with a retry, so a refused
 * submit still shows the link's error beside it and focuses the retry (audit A07-14).
 */
function LinkSelect({
  label,
  empty,
  items,
  read,
  value,
  onChange,
  invalid,
}: Omit<PickerProps, 'customerId'> & {
  label: string;
  empty: string;
  items: { value: string; label: string }[] | undefined;
  read: LinkRead;
}) {
  const { t } = useTranslation();
  if (read.isPending) return <Skeleton className="h-16 w-full" aria-hidden="true" />;
  return (
    <Field invalid={invalid}>
      <FieldLabel render={read.isError ? <span /> : undefined}>{label}</FieldLabel>
      {read.isError ? (
        <ReadFailure error={read.error} onRetry={() => read.refetch()} />
      ) : items && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Select items={items ?? []} value={value} onValueChange={(next) => onChange(next ?? null)}>
          <SelectTrigger aria-invalid={invalid || undefined}>
            <SelectValue placeholder={t('support.new.linkPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(items ?? []).map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <FieldError match={invalid}>{t('support.new.linkError')}</FieldError>
    </Field>
  );
}

/** The customer's last 30 orders: number, product, total, status. */
function OrderPicker({ customerId, ...props }: PickerProps) {
  const { t } = useTranslation();
  const orders = useQuery(linkOrdersQuery(customerId));
  const items = orders.data?.items.map((order) => ({
    value: order.id,
    label: `${ltr(order.number)} · ${order.product.nameAr} · ${ltr(formatUsd(order.totalUsdUnits))} · ${t(`orders.statuses.${order.status}`)}`,
  }));
  return (
    <LinkSelect
      {...props}
      label={t('support.new.order')}
      empty={t('support.new.noOrders')}
      items={items}
      read={orders}
    />
  );
}

/** The customer's last 30 deposits: reference, method, amount, status. */
function DepositPicker({ customerId, ...props }: PickerProps) {
  const { t } = useTranslation();
  const deposits = useQuery(linkDepositsQuery(customerId));
  const items = deposits.data?.items.map((deposit) => ({
    value: deposit.id,
    label: `${ltr(deposit.referenceCode)} · ${t(`wallets.methods.${deposit.method}`)} · ${ltr(formatUsd(deposit.declaredUsdUnits))} · ${t(`deposits.statuses.${deposit.status}`)} · ${formatDate(deposit.createdAt)}`,
  }));
  return (
    <LinkSelect
      {...props}
      label={t('support.new.deposit')}
      empty={t('support.new.noDeposits')}
      items={items}
      read={deposits}
    />
  );
}
