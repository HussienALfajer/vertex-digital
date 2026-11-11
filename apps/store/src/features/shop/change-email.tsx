'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { MailIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { clearErrorOnInput } from '@/lib/field-errors';
import { t } from '@/lib/i18n';
import { CodeInput } from '../auth/code-input';
import { codeError, currentPasswordError, emailError } from '../auth/validation';
import { SentTo } from '../auth/verify-email-panel';
import { ts } from './i18n';
import { shopConfirmEmailChange, shopRequestEmailChange } from './requests';

type Step = { name: 'closed' } | { name: 'request' } | { name: 'code'; newEmail: string };

/**
 * CA8 in "حسابي": the new address and the current password, then the code sent to the new
 * address; the old address gets a notice and the other sessions are signed out. Signed out
 * meanwhile, the page's own session check takes the customer to sign in.
 */
export function ShopChangeEmail({
  slug,
  onChanged,
}: {
  slug: string;
  onChanged: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>({ name: 'closed' });
  const [done, setDone] = useState(false);

  if (step.name === 'closed') {
    return (
      <div className="flex flex-col gap-3">
        {done && <FormAlert tone="success">{ts('account.emailDone')}</FormAlert>}
        <Button
          variant="outline"
          size="xl"
          className="self-start"
          onClick={() => {
            setDone(false);
            setStep({ name: 'request' });
          }}
        >
          <MailIcon aria-hidden="true" />
          {ts('account.emailChange')}
        </Button>
      </div>
    );
  }
  const close = () => setStep({ name: 'closed' });
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <h3 className="font-bold">{ts('account.emailTitle')}</h3>
      {step.name === 'request' ? (
        <RequestStep
          slug={slug}
          onSent={(newEmail) => setStep({ name: 'code', newEmail })}
          onCancel={close}
        />
      ) : (
        <CodeStep
          slug={slug}
          newEmail={step.newEmail}
          onDone={async () => {
            await onChanged();
            setDone(true);
            close();
          }}
          onCancel={close}
        />
      )}
    </div>
  );
}

function RequestStep({
  slug,
  onSent,
  onCancel,
}: {
  slug: string;
  onSent: (newEmail: string) => void;
  onCancel: () => void;
}) {
  const [errors, setErrors] = useState<{ newEmail?: string; password?: string }>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newEmail = String(data.get('newEmail') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const found = { newEmail: emailError(newEmail), password: currentPasswordError(password) };
    setErrors(found);
    setFailure(null);
    if (found.newEmail || found.password) return focusInvalid();
    setPending(true);
    const result = await shopRequestEmailChange(slug, { newEmail, password });
    setPending(false);
    if (result.ok) return onSent(newEmail);
    if (result.reason !== 'INVALID_PASSWORD') return setFailure(result.reason);
    setErrors({ password: errorText(result.reason) });
    focusInvalid();
  };

  return (
    <form
      ref={ref}
      noValidate
      onSubmit={onSubmit}
      onInput={clearErrorOnInput(setErrors)}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">{ts('account.emailSubtitle')}</p>
      <Field invalid={!!errors.newEmail}>
        <FieldLabel>{t('fields.newEmail')}</FieldLabel>
        <Input
          name="newEmail"
          type="email"
          dir="ltr"
          autoComplete="email"
          inputMode="email"
          className="h-11 text-md"
          aria-invalid={!!errors.newEmail}
        />
        <FieldError match={!!errors.newEmail}>{errors.newEmail}</FieldError>
      </Field>
      <Field invalid={!!errors.password}>
        <FieldLabel>{t('fields.currentPassword')}</FieldLabel>
        <PasswordInput
          name="password"
          autoComplete="current-password"
          className="h-11 text-md"
          showLabel={t('fields.showPassword')}
          hideLabel={t('fields.hidePassword')}
          aria-invalid={!!errors.password}
        />
        <FieldError match={!!errors.password}>{errors.password}</FieldError>
      </Field>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <InvalidAlert show={!!(errors.newEmail || errors.password)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? ts('account.emailSending') : ts('account.emailSend')}
        </Button>
        <Button type="button" variant="ghost" size="xl" onClick={onCancel}>
          {ts('account.emailCancel')}
        </Button>
      </div>
    </form>
  );
}

function CodeStep({
  slug,
  newEmail,
  onDone,
  onCancel,
}: {
  slug: string;
  newEmail: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [codeFailure, setCodeFailure] = useState<string | undefined>();
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = codeError(code);
    setCodeFailure(invalid);
    setFailure(null);
    if (invalid) return focusInvalid();
    setPending(true);
    const result = await shopConfirmEmailChange(slug, { newEmail, otp: code });
    if (result.ok) return onDone();
    setPending(false);
    if (result.reason !== 'INVALID_OTP') return setFailure(result.reason);
    setCodeFailure(errorText(result.reason));
    focusInvalid();
  };

  return (
    <div className="flex flex-col gap-4">
      <SentTo text={ts('account.emailCode')} email={newEmail} />
      <form ref={ref} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <CodeInput
          value={code}
          onValueChange={(value) => {
            setCode(value);
            setCodeFailure(undefined);
          }}
          error={codeFailure}
          autoFocus
        />
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="xl" disabled={pending}>
            {pending ? ts('account.emailSubmitting') : ts('account.emailSubmit')}
          </Button>
          <Button type="button" variant="ghost" size="xl" onClick={onCancel}>
            {ts('account.emailCancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
