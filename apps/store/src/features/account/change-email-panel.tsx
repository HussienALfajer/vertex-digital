'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { CodeInput } from '../auth/code-input';
import { codeError, currentPasswordError, emailError, focusFirst } from '../auth/validation';
import { SentTo } from '../auth/verify-email-panel';
import { confirmEmailChange, requestEmailChange } from './requests';

type Step = { name: 'request' } | { name: 'code'; newEmail: string } | { name: 'done' };

/**
 * Email change (rule C12): the new address and the current password, then the code sent to the
 * new address. The old address gets a notice; other sessions are signed out.
 */
export function ChangeEmailPanel() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: 'request' });

  const onUnauthorized = () => router.replace('/sign-in?next=%2Faccount%2Femail');

  if (step.name === 'done') {
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="success">{t('changeEmail.done')}</FormAlert>
        <Button size="xl" render={<Link href="/account" />}>
          {t('changeEmail.back')}
        </Button>
      </div>
    );
  }
  if (step.name === 'code') {
    return (
      <CodeStep
        newEmail={step.newEmail}
        onDone={() => setStep({ name: 'done' })}
        onUnauthorized={onUnauthorized}
      />
    );
  }
  return (
    <RequestStep
      onSent={(newEmail) => setStep({ name: 'code', newEmail })}
      onUnauthorized={onUnauthorized}
    />
  );
}

function RequestStep({
  onSent,
  onUnauthorized,
}: {
  onSent: (newEmail: string) => void;
  onUnauthorized: () => void;
}) {
  const [errors, setErrors] = useState<{ newEmail?: string; password?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newEmail = String(data.get('newEmail') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const found = { newEmail: emailError(newEmail), password: currentPasswordError(password) };
    setErrors(found);
    setFailure(null);
    if (found.newEmail || found.password) {
      focusFirst(form, found);
      return;
    }
    setPending(true);
    const result = await requestEmailChange({ newEmail, password });
    setPending(false);
    if (result.ok) return onSent(newEmail);
    if (result.reason === 'UNAUTHORIZED') return onUnauthorized();
    if (result.reason === 'INVALID_PASSWORD') setErrors({ password: errorText(result.reason) });
    else setFailure(result.reason);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
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
      <Button type="submit" size="xl" disabled={pending}>
        {pending ? t('changeEmail.sending') : t('changeEmail.send')}
      </Button>
      <Button variant="ghost" size="xl" render={<Link href="/account" />}>
        {t('changeEmail.back')}
      </Button>
    </form>
  );
}

function CodeStep({
  newEmail,
  onDone,
  onUnauthorized,
}: {
  newEmail: string;
  onDone: () => void;
  onUnauthorized: () => void;
}) {
  const [code, setCode] = useState('');
  const [codeFailure, setCodeFailure] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = codeError(code);
    setCodeFailure(invalid);
    setFailure(null);
    if (invalid) return;
    setPending(true);
    const result = await confirmEmailChange({ newEmail, otp: code });
    setPending(false);
    if (result.ok) return onDone();
    if (result.reason === 'UNAUTHORIZED') return onUnauthorized();
    if (result.reason === 'INVALID_OTP') setCodeFailure(errorText(result.reason));
    else setFailure(result.reason);
  };

  return (
    <div className="flex flex-col gap-5">
      <SentTo text={t('changeEmail.codeSubtitle')} email={newEmail} />
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        <CodeInput value={code} onValueChange={setCode} error={codeFailure} autoFocus />
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? t('changeEmail.submitting') : t('changeEmail.submit')}
        </Button>
        <Button variant="ghost" size="xl" render={<Link href="/account" />}>
          {t('changeEmail.back')}
        </Button>
      </form>
    </div>
  );
}
