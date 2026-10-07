'use client';

import { signInSchema } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { type FormEvent, useState } from 'react';
import { t } from '@/lib/i18n';
import { type SignInFailure, signIn } from './sign-in';

type FieldErrors = { email?: string; password?: string };

/** The contract's schema decides; the screen only picks the message for each refused field. */
function validate(email: string, password: string): FieldErrors {
  const result = signInSchema.safeParse({ email, password });
  if (result.success) return {};
  const refused = new Set(result.error.issues.map((issue) => issue.path[0]));
  const errors: FieldErrors = {};
  if (refused.has('email')) {
    errors.email = email ? t('signIn.emailInvalid') : t('signIn.emailRequired');
  }
  if (refused.has('password')) errors.password = t('signIn.passwordRequired');
  return errors;
}

export function SignInForm() {
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<SignInFailure | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const errors = validate(email, password);
    setFieldErrors(errors);
    setFailure(null);
    if (errors.email || errors.password) {
      const first = errors.email ? 'email' : 'password';
      form.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setPending(true);
    const result = await signIn(email, password);
    if (result.ok) {
      // A full load, so everything rendered for a signed-out visitor is read again.
      window.location.assign('/');
      return;
    }
    setPending(false);
    setFailure(result.reason);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      <Field invalid={!!fieldErrors.email}>
        <FieldLabel>{t('signIn.email')}</FieldLabel>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          inputMode="email"
          className="h-11 text-md"
          aria-invalid={!!fieldErrors.email}
        />
        <FieldError match={!!fieldErrors.email}>{fieldErrors.email}</FieldError>
      </Field>
      <Field invalid={!!fieldErrors.password}>
        <FieldLabel>{t('signIn.password')}</FieldLabel>
        <PasswordInput
          name="password"
          autoComplete="current-password"
          className="h-11 text-md"
          showLabel={t('signIn.showPassword')}
          hideLabel={t('signIn.hidePassword')}
          aria-invalid={!!fieldErrors.password}
        />
        <FieldError match={!!fieldErrors.password}>{fieldErrors.password}</FieldError>
      </Field>
      {failure && (
        <p
          role="alert"
          className="rounded-md bg-status-danger px-4 py-3 text-sm text-status-danger-foreground"
        >
          {t(`errors.${failure}`)}
        </p>
      )}
      <Button type="submit" size="xl" disabled={pending}>
        {pending ? t('signIn.submitting') : t('signIn.submit')}
      </Button>
    </form>
  );
}
