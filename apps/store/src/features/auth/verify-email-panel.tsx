'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { MailQuestionIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { withNext } from '@/lib/safe-redirect';
import { CodeInput } from './code-input';
import {
  clearPendingEmail,
  type PendingEmail,
  readHeldPassword,
  readPendingEmail,
} from './pending-email';
import { sendVerificationCode, verifyEmail } from './requests';
import { FormSkeleton } from './sign-up-panel';
import { useCountdown } from './use-countdown';
import { codeError, currentPasswordError } from './validation';

/**
 * The email code after sign-up or an unverified sign-in (rules C4, C7): the right code, with the
 * password just typed, signs the customer in and goes back where they were heading. After a reload
 * the password is no longer held, so the page asks for it (F2-7).
 */
export function VerifyEmailPanel() {
  const [pending, setPending] = useState<PendingEmail | null | undefined>(undefined);

  useEffect(() => setPending(readPendingEmail()), []);

  if (pending === undefined) return <FormSkeleton fields={1} />;
  if (pending === null) {
    return (
      <EmptyState
        icon={<MailQuestionIcon />}
        title={t('verifyEmail.missingTitle')}
        description={t('verifyEmail.missingBody')}
        action={
          <Button variant="outline" size="xl" render={<Link href="/sign-in" />}>
            {t('signIn.title')}
          </Button>
        }
      />
    );
  }
  return <VerifyEmailForm pending={pending} />;
}

function VerifyEmailForm({ pending: { email, next } }: { pending: PendingEmail }) {
  const [code, setCode] = useState('');
  const [codeFailure, setCodeFailure] = useState<string | undefined>();
  const [held] = useState(readHeldPassword);
  const [passwordFailure, setPasswordFailure] = useState<string | undefined>();
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const countdown = useCountdown(60);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = held ?? String(new FormData(event.currentTarget).get('password') ?? '');
    const invalid = codeError(code);
    const passwordInvalid = held ? undefined : currentPasswordError(password);
    setCodeFailure(invalid);
    setPasswordFailure(passwordInvalid);
    setFailure(null);
    setNotice(false);
    if (invalid || passwordInvalid) return focusInvalid();
    setSubmitting(true);
    const result = await verifyEmail(email, code, password);
    if (result.ok) {
      clearPendingEmail();
      // A full load, so everything rendered for a signed-out visitor is read again.
      window.location.assign(next);
      return;
    }
    setSubmitting(false);
    if (result.reason !== 'INVALID_OTP') return setFailure(result.reason);
    setCodeFailure(errorText(result.reason));
    focusInvalid();
  };

  const resend = async () => {
    setResending(true);
    setFailure(null);
    setNotice(false);
    const result = await sendVerificationCode(email);
    setResending(false);
    if (!result.ok) return setFailure(result.reason);
    setCode('');
    setCodeFailure(undefined);
    setNotice(true);
    countdown.restart();
  };

  return (
    <div className="flex flex-col gap-5">
      <SentTo text={t('verifyEmail.subtitle')} email={email} />
      <form
        ref={ref}
        noValidate
        onSubmit={onSubmit}
        onInput={(event) => {
          if ((event.target as HTMLInputElement).name === 'password') setPasswordFailure(undefined);
        }}
        className="flex flex-col gap-5"
      >
        <CodeInput
          value={code}
          onValueChange={(value) => {
            setCode(value);
            setCodeFailure(undefined);
          }}
          error={codeFailure}
          autoFocus
        />
        {!held && (
          <Field invalid={!!passwordFailure}>
            <FieldLabel>{t('fields.password')}</FieldLabel>
            <PasswordInput
              name="password"
              autoComplete="current-password"
              className="h-11 text-md"
              showLabel={t('fields.showPassword')}
              hideLabel={t('fields.hidePassword')}
              aria-invalid={!!passwordFailure}
            />
            <FieldDescription>{t('verifyEmail.passwordHint')}</FieldDescription>
            <FieldError match={!!passwordFailure}>{passwordFailure}</FieldError>
          </Field>
        )}
        {/* An expired or voided code says to request a new one (rule C4); a right code with
            another password sends to "forgot password" (F2-7). */}
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        {failure === 'PASSWORD_MISMATCH' && (
          <Button variant="outline" size="xl" render={<Link href="/forgot-password" />}>
            {t('signIn.forgotPassword')}
          </Button>
        )}
        {notice && <FormAlert tone="success">{t('verifyEmail.resent')}</FormAlert>}
        {/* With the password asked for, two fields can be refused (store rule). */}
        <InvalidAlert show={!held && !!(codeFailure || passwordFailure)} />
        <Button type="submit" size="xl" disabled={submitting}>
          {submitting ? t('verifyEmail.submitting') : t('verifyEmail.submit')}
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
          <Button variant="ghost" size="xl" render={<Link href={withNext('/sign-up', next)} />}>
            {t('verifyEmail.changeEmail')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where a code went: the sentence, then the address on its own line, left to right. */
export function SentTo({ text, email }: { text: string; email: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-base text-muted-foreground">{text}</p>
      <p dir="ltr" className="text-end font-medium break-all">
        {email}
      </p>
    </div>
  );
}
