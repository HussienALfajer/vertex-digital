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
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import { forgetThisBrowser } from '@/features/account/signed-out';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { clearErrorOnInput } from '@/lib/field-errors';
import { t } from '@/lib/i18n';
import { safeRedirect, withNext } from '@/lib/safe-redirect';
import { useSearchParam } from '@/lib/use-search-param';
import { CodeInput } from './code-input';
import { requestPasswordReset, resetPassword } from './requests';
import { useCountdown } from './use-countdown';
import { useLeaveIfSignedIn } from './use-leave-if-signed-in';
import { codeError, emailError, newPasswordError } from './validation';
import { SentTo } from './verify-email-panel';

/**
 * Password recovery by email code (rule C7): the email first (the same answer whether or not it
 * has an account), then the code and the new password, with "send a new code" (A01-10). Success
 * signs out every session and sends the customer to sign in, then on to `?next=` (A01-19).
 */
export function ForgotPasswordPanel() {
  const next = useSearchParam('next');
  const [email, setEmail] = useState<string | null>(null);
  useLeaveIfSignedIn();
  return email === null ? (
    <EmailStep next={next} onSent={setEmail} />
  ) : (
    <ResetStep email={email} next={next} onOtherEmail={() => setEmail(null)} />
  );
}

function EmailStep({ next, onSent }: { next: string | null; onSent: (email: string) => void }) {
  const [error, setError] = useState<string | undefined>();
  const { ref, focusInvalid } = useFocusInvalid();
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
      return focusInvalid();
    }
    setPending(true);
    const result = await requestPasswordReset(email);
    setPending(false);
    if (result.ok) onSent(email);
    else setFailure(result.reason);
  };

  return (
    <form
      ref={ref}
      noValidate
      onSubmit={onSubmit}
      onInput={() => setError(undefined)}
      className="flex flex-col gap-5"
    >
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
      <Button variant="ghost" size="xl" render={<Link href={withNext('/sign-in', next)} />}>
        {t('forgotPassword.back')}
      </Button>
    </form>
  );
}

function ResetStep({
  email,
  next,
  onOtherEmail,
}: {
  email: string;
  next: string | null;
  onOtherEmail: () => void;
}) {
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ code?: string; password?: string }>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(false);
  const [resending, setResending] = useState(false);
  // The first code was just sent: a new one may be asked for after a minute (rule C5).
  const countdown = useCountdown(60);

  const resend = async () => {
    setResending(true);
    setFailure(null);
    setNotice(false);
    const result = await requestPasswordReset(email);
    setResending(false);
    if (!result.ok) return setFailure(result.reason);
    setCode('');
    setErrors((current) => ({ ...current, code: undefined }));
    setNotice(true);
    countdown.restart();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    const found = { code: codeError(code), password: newPasswordError(password, email) };
    setErrors(found);
    setFailure(null);
    if (found.code || found.password) {
      return focusInvalid();
    }
    setPending(true);
    setNotice(false);
    const result = await resetPassword({ email, otp: code, password });
    if (result.ok) {
      // Every session of the account ended (C7), this browser's too if it had one: it forgets it,
      // and a full load shows the header signed out (A01-13).
      await forgetThisBrowser();
      const target = safeRedirect(next);
      window.location.assign(
        `/sign-in?notice=password-reset${target === '/' ? '' : `&next=${encodeURIComponent(target)}`}`,
      );
      return;
    }
    setPending(false);
    if (result.reason === 'INVALID_OTP') setErrors({ code: errorText(result.reason) });
    else if (result.reason === 'PASSWORD_TOO_COMMON') {
      setErrors({ password: t('validation.passwordCommon') });
    } else return setFailure(result.reason);
    focusInvalid();
  };

  return (
    <div className="flex flex-col gap-5">
      <SentTo text={t('forgotPassword.codeSubtitle')} email={email} />
      <form
        ref={ref}
        noValidate
        onSubmit={onSubmit}
        onInput={clearErrorOnInput(setErrors)}
        className="flex flex-col gap-5"
      >
        <CodeInput
          value={code}
          onValueChange={(value) => {
            setCode(value);
            setErrors((current) => ({ ...current, code: undefined }));
          }}
          error={errors.code}
          autoFocus
        />
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
        {notice && <FormAlert tone="success">{t('verifyEmail.resent')}</FormAlert>}
        <InvalidAlert show={!!(errors.code || errors.password)} />
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
        </Button>
      </form>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">{t('verifyEmail.checkSpam')}</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="xl"
            onClick={resend}
            disabled={countdown.left > 0 || resending}
          >
            {countdown.left > 0
              ? t('verifyEmail.resendIn', { seconds: countdown.left })
              : t('verifyEmail.resend')}
          </Button>
          <Button variant="ghost" size="xl" onClick={onOtherEmail}>
            {t('forgotPassword.otherEmail')}
          </Button>
        </div>
      </div>
    </div>
  );
}
