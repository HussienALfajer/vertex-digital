'use client';

import { Button } from '@vertex-digital/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { CodeInput } from './code-input';
import { requestPasswordReset, resetPassword } from './requests';
import { codeError, emailError, focusFirst, newPasswordError } from './validation';
import { SentTo } from './verify-email-panel';

/**
 * Password recovery by email code (rule C7): the email first (the same answer whether or not it
 * has an account), then the code and the new password. Success signs out every session and sends
 * the customer to sign in.
 */
export function ForgotPasswordPanel() {
  const [email, setEmail] = useState<string | null>(null);
  return email === null ? (
    <EmailStep onSent={setEmail} />
  ) : (
    <ResetStep email={email} onOtherEmail={() => setEmail(null)} />
  );
}

function EmailStep({ onSent }: { onSent: (email: string) => void }) {
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get('email') ?? '').trim();
    const invalid = emailError(email);
    setError(invalid);
    setFailure(null);
    if (invalid) {
      focusFirst(form, { email: invalid });
      return;
    }
    setPending(true);
    const result = await requestPasswordReset(email);
    setPending(false);
    if (result.ok) onSent(email);
    else setFailure(result.reason);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      <Field invalid={!!error}>
        <FieldLabel>{t('fields.email')}</FieldLabel>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          inputMode="email"
          className="h-11 text-md"
          aria-invalid={!!error}
        />
        <FieldError match={!!error}>{error}</FieldError>
      </Field>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <Button type="submit" size="xl" disabled={pending}>
        {pending ? t('forgotPassword.sending') : t('forgotPassword.send')}
      </Button>
      <Button variant="ghost" size="xl" render={<Link href="/sign-in" />}>
        {t('forgotPassword.back')}
      </Button>
    </form>
  );
}

function ResetStep({ email, onOtherEmail }: { email: string; onOtherEmail: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ code?: string; password?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    const found = { code: codeError(code), password: newPasswordError(password, email) };
    setErrors(found);
    setFailure(null);
    if (found.code || found.password) {
      focusFirst(form, found);
      return;
    }
    setPending(true);
    const result = await resetPassword({ email, otp: code, password });
    if (result.ok) {
      router.push('/sign-in?notice=password-reset');
      return;
    }
    setPending(false);
    if (result.reason === 'INVALID_OTP') setErrors({ code: errorText(result.reason) });
    else if (result.reason === 'PASSWORD_TOO_COMMON') {
      setErrors({ password: t('validation.passwordCommon') });
    } else setFailure(result.reason);
  };

  return (
    <div className="flex flex-col gap-5">
      <SentTo text={t('forgotPassword.codeSubtitle')} email={email} />
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        <CodeInput value={code} onValueChange={setCode} error={errors.code} autoFocus />
        <Field invalid={!!errors.password}>
          <FieldLabel>{t('fields.newPassword')}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!errors.password}
          />
          <FieldDescription>{t('fields.passwordHint')}</FieldDescription>
          <FieldError match={!!errors.password}>{errors.password}</FieldError>
        </Field>
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
        </Button>
        <Button variant="ghost" size="xl" onClick={onOtherEmail}>
          {t('forgotPassword.otherEmail')}
        </Button>
      </form>
    </div>
  );
}
