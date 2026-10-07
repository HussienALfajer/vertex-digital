'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { safeRedirect } from '@/lib/safe-redirect';
import { useSearchParam } from '@/lib/use-search-param';
import { savePendingEmail } from './pending-email';
import { registrationState, signIn } from './requests';
import { currentPasswordError, emailError, focusFirst } from './validation';

/** Why the customer arrived here, from `?notice=`: shown above the form. */
const NOTICES = {
  'password-reset': 'signIn.passwordReset',
  'signed-out': 'signIn.signedOut',
} as const;

export function SignInForm() {
  const router = useRouter();
  const next = useSearchParam('next');
  const notice = useSearchParam('notice');
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [canSignUp, setCanSignUp] = useState(false);

  useEffect(() => {
    let active = true;
    registrationState().then((state) => active && setCanSignUp(state === 'open'));
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const found = { email: emailError(email), password: currentPasswordError(password) };
    setErrors(found);
    setFailure(null);
    if (found.email || found.password) {
      focusFirst(form, found);
      return;
    }
    setPending(true);
    const result = await signIn(email, password, { onVerifying: () => setVerifying(true) });
    setVerifying(false);
    if (result.ok) {
      // A full load, so everything rendered for a signed-out visitor is read again.
      window.location.assign(safeRedirect(next));
      return;
    }
    // The API sent a new code to an unverified account (account states): enter it next.
    if (result.reason === 'EMAIL_NOT_VERIFIED') {
      savePendingEmail({ email, next: safeRedirect(next) });
      router.push('/verify-email');
      return;
    }
    setPending(false);
    setFailure(result.reason);
  };

  const noticeKey = notice && notice in NOTICES ? NOTICES[notice as keyof typeof NOTICES] : null;

  return (
    <div className="flex flex-col gap-5">
      {noticeKey && <FormAlert tone="success">{t(noticeKey)}</FormAlert>}
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field invalid={!!errors.email}>
          <FieldLabel>{t('fields.email')}</FieldLabel>
          <Input
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            inputMode="email"
            className="h-11 text-md"
            aria-invalid={!!errors.email}
          />
          <FieldError match={!!errors.email}>{errors.email}</FieldError>
        </Field>
        <Field invalid={!!errors.password}>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>{t('fields.password')}</FieldLabel>
            <Link
              href="/forgot-password"
              className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline"
            >
              {t('signIn.forgotPassword')}
            </Link>
          </div>
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
          {verifying
            ? t('signIn.verifying')
            : pending
              ? t('signIn.submitting')
              : t('signIn.submit')}
        </Button>
      </form>
      {canSignUp && (
        <p className="text-center text-sm text-muted-foreground">
          {t('signIn.noAccount')}{' '}
          <Link
            href="/sign-up"
            className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline"
          >
            {t('signIn.signUpLink')}
          </Link>
        </p>
      )}
    </div>
  );
}
