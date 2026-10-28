'use client';

import {
  formatUsd,
  maskFieldValue,
  type Order,
  type OrderProblemOption,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@vertex-digital/ui/components/field';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { attemptSignature } from '@/features/support/form';
import { ImagePicker } from '@/features/support/image-picker';
import { openTicket } from '@/features/support/requests';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { useIdempotentRequest } from '@/lib/idempotency';
import { th } from './i18n';
import { problemLabel, problemTicket } from './problems';

/** TK7: a ticket's body is at most 2000 characters, the problem's sentence included. */
const BODY_MAX = 2000;

/**
 * One problem's sheet (S22 OP4, OP5): first what the customer can check (with "افتح تذكرة على
 * أي حال" always there), then the form: the problem as a chip, optional details and up to 3
 * images, sent as an order ticket naming the problem. A problem the order no longer offers says so
 * in the sheet, keeping what was typed, and the card refreshes once it is closed (edge cases 13,
 * 14; audit A04-41); an open ticket is linked.
 */
export function ProblemSheet({
  order,
  option,
  onOpenChange,
  onRefused,
}: {
  order: Order;
  option: OrderProblemOption;
  onOpenChange: (open: boolean) => void;
  onRefused: () => void;
}) {
  const router = useRouter();
  // OP4's refund hint only names a refund that happened: an amount back and the order closed.
  const hint =
    option.hint === 'refund_returned' &&
    !(order.refundedUsdUnits && order.refundedUsdUnits > 0 && order.help.finishedAt)
      ? null
      : option.hint;
  const [step, setStep] = useState<'hint' | 'form'>(hint ? 'hint' : 'form');
  const [details, setDetails] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<{ reason: Failure; ticketId?: string } | null>(null);
  const sendOnce = useIdempotentRequest();
  const label = problemLabel(option.problem, order.help.status);
  const detailsMax = BODY_MAX - th(`sentences.${option.problem}`).length - 2;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setRefusal(null);
    const ticket = problemTicket(option.problem, order.help.status, order.number, details);
    const fields = {
      category: 'order' as const,
      orderId: order.id,
      orderProblem: option.problem,
      ...ticket,
    };
    setSending(true);
    const result = await sendOnce(attemptSignature(fields, files), (key) =>
      openTicket(fields, files, key),
    );
    if (result.ok) {
      router.push(`/support/${result.data.id}`);
      return;
    }
    setSending(false);
    const ticketId = (result.details as { ticketId?: unknown } | undefined)?.ticketId;
    setRefusal({ reason: result.reason, ...(typeof ticketId === 'string' && { ticketId }) });
  }

  return (
    <Sheet
      guardTyped={false}
      open
      onOpenChange={(open) =>
        !open && refusal?.reason === 'ORDER_PROBLEM_UNAVAILABLE' ? onRefused() : onOpenChange(open)
      }
    >
      <SheetContent side="bottom" className="gap-4 bg-surface p-5 pb-8" data-testid="problem-sheet">
        <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
          <SheetTitle className="text-lg font-bold">{label}</SheetTitle>
          {step === 'hint' ? (
            <>
              <Hint order={order} option={{ ...option, hint }} />
              <div className="flex flex-col gap-2">
                {hint === 'usual_time' && (
                  <Button size="xl" onClick={() => onOpenChange(false)}>
                    {th('hints.wait')}
                  </Button>
                )}
                <Button
                  size="xl"
                  variant={hint === 'usual_time' ? 'outline' : 'primary'}
                  onClick={() => setStep('form')}
                >
                  {th('hints.anyway')}
                </Button>
              </div>
            </>
          ) : (
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(event) => void submit(event)}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{th('form.problem')}</span>
                <Badge tone="warning">{label}</Badge>
              </div>
              <Field>
                <FieldLabel>{th('form.details')}</FieldLabel>
                <Textarea
                  value={details}
                  maxLength={detailsMax}
                  rows={4}
                  className="text-md"
                  placeholder={th('form.placeholder')}
                  disabled={sending}
                  onChange={(event) => setDetails(event.target.value)}
                />
                <FieldDescription>
                  <span className="tabular-nums" dir="ltr">
                    {th('form.counter', { count: details.length, max: detailsMax })}
                  </span>
                </FieldDescription>
              </Field>
              {hint === 'code_help' && (
                <p className="text-sm text-muted-foreground">{th('hints.attach')}</p>
              )}
              <ImagePicker files={files} onChange={setFiles} disabled={sending} />
              {refusal && (
                <div className="flex flex-col gap-2">
                  <FormAlert>
                    {refusal.reason === 'TICKET_ALREADY_OPEN'
                      ? th('form.alreadyOpen')
                      : errorText(refusal.reason)}
                  </FormAlert>
                  {refusal.ticketId && (
                    <Link
                      href={`/support/${refusal.ticketId}`}
                      prefetch={false}
                      className="w-fit font-medium underline underline-offset-4"
                    >
                      {th('card.openTicketLink')}
                    </Link>
                  )}
                </div>
              )}
              <Button type="submit" size="xl" disabled={sending}>
                {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                {sending ? th('form.sending') : th('form.send')}
              </Button>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** OP4's hint, from the order the page shows. */
function Hint({ order, option }: { order: Order; option: OrderProblemOption }) {
  const firstField = order.fields[0]?.value;
  const id = firstField ? ltr(maskFieldValue(firstField)) : null;
  const finished = order.help.finishedAt ? formatDateTime(order.help.finishedAt) : null;
  switch (option.hint) {
    case 'usual_time':
      return <p>{th('hints.usual_time', { minutes: option.usualMinutes ?? 1 })}</p>;
    case 'game_delay':
      return <p>{id ? th('hints.game_delay', { id }) : th('hints.game_delay_no_id')}</p>;
    case 'player_id_locked':
      return <p>{th('hints.player_id_locked')}</p>;
    case 'delivered_to_id':
      return <p>{th('hints.delivered_to_id', { id: id ?? '••••' })}</p>;
    case 'code_help':
      return (
        <div className="flex flex-col gap-2">
          {order.product.regionAr && (
            <p>{th('hints.region', { region: order.product.regionAr })}</p>
          )}
          {order.product.redemptionAr && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-bold">{th('hints.steps')}</h3>
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {order.product.redemptionAr}
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{th('hints.attach')}</p>
        </div>
      );
    case 'refund_returned':
      return (
        <div className="flex flex-col gap-2">
          <p>
            {th('hints.refund_returned', {
              amount: ltr(formatUsd(order.refundedUsdUnits ?? 0)),
              time: finished ?? '',
            })}
          </p>
          <Link
            href="/wallet"
            prefetch={false}
            className="w-fit font-medium underline underline-offset-4"
          >
            {th('hints.wallet')}
          </Link>
        </div>
      );
    default:
      return null;
  }
}
