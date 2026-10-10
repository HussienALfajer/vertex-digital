'use client';

import { type Gift, giftTextAllowed } from '@vertex-digital/contracts';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { useId } from 'react';
import { t } from '@/lib/i18n';

export const GIFT_SENDER_MAX = 30;
export const GIFT_MESSAGE_MAX = 140;

export type GiftDraft = { on: boolean; senderName: string; message: string };

export const NO_GIFT: GiftDraft = { on: false, senderName: '', message: '' };

type GiftErrors = { senderName?: string; message?: string };

/** Rule GF3 per field, with the same rule the server applies (`giftSchema`). */
export function giftErrors(draft: GiftDraft): GiftErrors {
  if (!draft.on) return {};
  const errors: GiftErrors = {};
  for (const [key, max] of [
    ['senderName', GIFT_SENDER_MAX],
    ['message', GIFT_MESSAGE_MAX],
  ] as const) {
    const value = draft[key].trim();
    if ([...value].length > max) errors[key] = t('purchase.gift.tooLong', { max });
    else if (!giftTextAllowed(value)) errors[key] = t('purchase.gift.refused');
  }
  return errors;
}

/** The request's `gift` (rule GF1): only the texts written; none when the box is not ticked. */
export function giftOf(draft: GiftDraft): Gift | undefined {
  if (!draft.on) return undefined;
  const senderName = draft.senderName.trim();
  const message = draft.message.trim();
  return { ...(senderName && { senderName }), ...(message && { message }) };
}

/**
 * "هذا الشحن هدية" (rule GF1) for a direct product: the sender name as the recipient will read it
 * and a message with its counter, both text only (GF3), errors under each field once shown.
 */
export function GiftBox({
  draft,
  showErrors,
  onChange,
}: {
  draft: GiftDraft;
  showErrors: boolean;
  onChange: (draft: GiftDraft) => void;
}) {
  const id = useId();
  const errors = showErrors ? giftErrors(draft) : {};
  const length = [...draft.message].length;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3">
        <Checkbox
          id={id}
          checked={draft.on}
          onCheckedChange={(checked) => onChange({ ...draft, on: checked })}
        />
        <span className="text-base">{t('purchase.gift.toggle')}</span>
      </label>
      {draft.on && (
        <>
          <Field invalid={!!errors.senderName}>
            <FieldLabel>{t('purchase.gift.sender')}</FieldLabel>
            <Input
              value={draft.senderName}
              maxLength={GIFT_SENDER_MAX + 10}
              autoComplete="off"
              className="h-11 text-md"
              aria-invalid={!!errors.senderName}
              onChange={(event) => onChange({ ...draft, senderName: event.target.value })}
            />
            <FieldError match={!!errors.senderName}>{errors.senderName}</FieldError>
          </Field>
          <Field invalid={!!errors.message}>
            <FieldLabel>{t('purchase.gift.message')}</FieldLabel>
            <Textarea
              value={draft.message}
              maxLength={GIFT_MESSAGE_MAX + 20}
              className="text-md"
              aria-invalid={!!errors.message}
              onChange={(event) => onChange({ ...draft, message: event.target.value })}
            />
            <FieldDescription>
              <span className="tabular-nums" dir="ltr">
                {length}/{GIFT_MESSAGE_MAX}
              </span>{' '}
              · {t('purchase.gift.textOnly')}
            </FieldDescription>
            <FieldError match={!!errors.message}>{errors.message}</FieldError>
          </Field>
        </>
      )}
    </div>
  );
}
