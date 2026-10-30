'use client';

import { TICKET_CATEGORIES, type TicketCategory } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  CircleHelpIcon,
  LoaderCircleIcon,
  type LucideIcon,
  ShoppingBagIcon,
  UserRoundIcon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { InvalidAlert } from '@/components/invalid-alert';
import { sendAttempt } from '@/features/purchase/attempt';
import { useCustomer } from '@/features/purchase/session';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import {
  attemptSignature,
  BODY_MAX,
  bodyLength,
  type DraftProblem,
  draftProblems,
  freesSupportKey,
  messageBody,
  TICKET_SLOT,
  type TicketDraft,
} from './form';
import { ImagePicker } from './image-picker';
import { LinkPicker } from './link-picker';
import { MerchantSupport } from './merchant-support';
import { openTicket } from './requests';

const CATEGORY_ICONS: Record<TicketCategory, LucideIcon> = {
  order: ShoppingBagIcon,
  deposit: WalletIcon,
  account: UserRoundIcon,
  other: CircleHelpIcon,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal that sends the customer elsewhere: their tickets, or the ticket already open. */
type Refusal = { reason: Failure; ticketId?: string };

const EMPTY: TicketDraft = {
  category: null,
  orderId: null,
  depositId: null,
  subject: '',
  body: '',
};

/** `?category=`, `?order=`, `?deposit=` (the help buttons, the frozen banner, TK4's new ticket). */
function draftFromUrl(): TicketDraft {
  const params = new URLSearchParams(window.location.search);
  const category = params.get('category');
  const known = (TICKET_CATEGORIES as readonly string[]).includes(category ?? '')
    ? (category as TicketCategory)
    : null;
  const id = (name: string) => {
    const value = params.get(name);
    return value && UUID.test(value) ? value : null;
  };
  return {
    ...EMPTY,
    category: known,
    orderId: known === 'order' ? id('order') : null,
    depositId: known === 'deposit' ? id('deposit') : null,
  };
}

/** Sign-in, then back to this form with its type and link (audit A07-38). */
function signInHref(): string {
  const next = `${window.location.pathname}${window.location.search}`;
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/**
 * `/support/new` (S12 TK1): the type as four large choices; for an order or a deposit, a picker of
 * the customer's last 30; the subject; the message with its counter; up to 3 images; "إرسال" as
 * multipart with an `Idempotency-Key` per attempt (kept in this tab's session storage, so a retry
 * after a lost answer and a reload returns the first ticket, audit A07-39) and the ALTCHA proof.
 * Every value stays after a refusal; the limit and an already open ticket link to where the
 * customer can go on.
 */
export function NewTicketPage() {
  const router = useRouter();
  const customer = useCustomer();
  const [draft, setDraft] = useState<TicketDraft>(EMPTY);
  const [prefill, setPrefill] = useState<{ order: string | null; deposit: string | null }>({
    order: null,
    deposit: null,
  });
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  useEffect(() => {
    const initial = draftFromUrl();
    setDraft(initial);
    setPrefill({ order: initial.orderId, deposit: initial.depositId });
    setReady(true);
  }, []);

  useEffect(() => {
    if (customer.status !== 'signedOut') return;
    router.replace(signInHref());
  }, [customer.status, router]);

  const problems = new Set<DraftProblem>(showErrors ? draftProblems(draft, files.length) : []);
  const change = (changes: Partial<TicketDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    setRefusal(null);
    if (draftProblems(draft, files.length).length > 0 || !draft.category) return focusInvalid();
    const fields = {
      category: draft.category,
      orderId: draft.category === 'order' ? draft.orderId : null,
      depositId: draft.category === 'deposit' ? draft.depositId : null,
      subject: draft.subject.trim(),
      body: messageBody(draft.body, files.length, t('support.images.attached')),
    };
    setSending(true);
    const result = await sendAttempt(
      TICKET_SLOT,
      attemptSignature(fields, files),
      (key) => openTicket(fields, files, key),
      freesSupportKey,
    );
    if (result.ok) {
      router.push(`/support/${result.data.id}`);
      return;
    }
    setSending(false);
    if (result.reason === 'UNAUTHORIZED') {
      router.push(signInHref());
      return;
    }
    const ticketId = (result.details as { ticketId?: unknown } | undefined)?.ticketId;
    setRefusal({
      reason: result.reason,
      ...(typeof ticketId === 'string' && { ticketId }),
    });
  }

  if (!ready || customer.status !== 'signedIn') return <NewTicketSkeleton />;

  return (
    <form
      ref={ref}
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <MerchantSupport />
      <Field invalid={problems.has('category')}>
        <FieldLabel render={<span />}>{t('support.new.category')}</FieldLabel>
        <ToggleGroup<TicketCategory>
          aria-label={t('support.new.category')}
          className="grid w-full grid-cols-2 gap-2 border-0 bg-transparent p-0"
          value={draft.category ? [draft.category] : []}
          disabled={sending}
          onValueChange={(value) => {
            const category = value[0];
            if (category) change({ category });
          }}
        >
          {TICKET_CATEGORIES.map((category) => {
            const Icon = CATEGORY_ICONS[category];
            return (
              <ToggleGroupItem
                key={category}
                value={category}
                className="h-auto min-h-20 flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-3 text-md whitespace-normal [&_svg:not([class*='size-'])]:size-6"
              >
                <Icon aria-hidden="true" />
                <span className="font-medium">{t(`support.categories.${category}`)}</span>
                <span className="text-xs opacity-80">
                  {t(`support.new.categoryHints.${category}`)}
                </span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldError match={problems.has('category')}>{t('support.validation.category')}</FieldError>
      </Field>

      {draft.category === 'order' && (
        <LinkPicker
          kind="order"
          value={draft.orderId}
          prefill={prefill.order}
          invalid={problems.has('order')}
          error={t('support.validation.order')}
          disabled={sending}
          onChange={(orderId) => change({ orderId })}
        />
      )}
      {draft.category === 'deposit' && (
        <LinkPicker
          kind="deposit"
          value={draft.depositId}
          prefill={prefill.deposit}
          invalid={problems.has('deposit')}
          error={t('support.validation.deposit')}
          disabled={sending}
          onChange={(depositId) => change({ depositId })}
        />
      )}

      <Field invalid={problems.has('subject')}>
        <FieldLabel>{t('support.new.subject')}</FieldLabel>
        <Input
          value={draft.subject}
          maxLength={120}
          autoComplete="off"
          className="h-11 text-md"
          aria-invalid={problems.has('subject')}
          disabled={sending}
          onChange={(event) => change({ subject: event.target.value })}
        />
        <FieldDescription>{t('support.new.subjectHint')}</FieldDescription>
        <FieldError match={problems.has('subject')}>{t('support.validation.subject')}</FieldError>
      </Field>

      <Field invalid={problems.has('body')}>
        <FieldLabel>{t('support.new.message')}</FieldLabel>
        <Textarea
          value={draft.body}
          maxLength={BODY_MAX}
          rows={5}
          className="text-md"
          aria-invalid={problems.has('body')}
          disabled={sending}
          onChange={(event) => change({ body: event.target.value })}
        />
        <FieldDescription>
          <span className="tabular-nums" dir="ltr">
            {t('support.new.counter', { count: bodyLength(draft.body), max: BODY_MAX })}
          </span>
        </FieldDescription>
        <FieldError match={problems.has('body')}>{t('support.validation.body')}</FieldError>
      </Field>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('support.images.label')}</p>
        <p className="text-sm text-muted-foreground">{t('support.images.hint')}</p>
        <ImagePicker files={files} onChange={setFiles} disabled={sending} />
      </div>

      {refusal && <RefusalAlert refusal={refusal} />}
      <InvalidAlert show={problems.size > 0} />

      <Button type="submit" size="xl" disabled={sending}>
        {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
        {sending ? t('support.new.sending') : t('support.new.submit')}
      </Button>
    </form>
  );
}

/** A refusal with its next step (S12 screens): the open tickets, or the ticket already open. */
function RefusalAlert({ refusal }: { refusal: Refusal }) {
  const link =
    refusal.reason === 'TICKETS_LIMIT_REACHED'
      ? { href: '/support', text: t('support.new.openTickets') }
      : refusal.reason === 'TICKET_ALREADY_OPEN' && refusal.ticketId
        ? { href: `/support/${refusal.ticketId}`, text: t('support.new.openExisting') }
        : null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md bg-status-danger px-4 py-3 text-sm text-status-danger-foreground"
    >
      <p>{errorText(refusal.reason)}</p>
      {link && (
        <Link href={link.href} className="w-fit font-medium underline underline-offset-4">
          {link.text}
        </Link>
      )}
    </div>
  );
}

export function NewTicketSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((cell) => (
          <Skeleton key={cell} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
