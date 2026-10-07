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
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { safeRedirect } from '@/lib/safe-redirect';
import { useSearchParam } from '@/lib/use-search-param';
import { savePendingEmail } from './pending-email';
import { DEFAULT_COUNTRY, toE164 } from './phone';
import { PhoneField } from './phone-field';
import { signUp } from './requests';
import { emailError, focusFirst, nameError, newPasswordError } from './validation';

type Fields = 'name' | 'email' | 'password' | 'phone';

/**
 * Sign-up (rule C1): name, email, password and phone, with a solved ALTCHA. The answer is the same
 * for a known email (rule C2), so the next step is always the code screen.
 */
export function SignUpForm({ onClosed }: { onClosed: () => void }) {
  const router = useRouter();
  const next = useSearchParam('next');
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [phone, setPhone] = useState('');
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [failure, setFailure] = useState<Failure | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const e164 = toE164(phone, country);
    const found = {
      name: nameError(name),
      email: emailError(email),
      password: newPasswordError(password, email),
      phone: e164 ? undefined : t('validation.phoneInvalid'),
    };
    setErrors(found);
    setFailure(null);
    if (Object.values(found).some(Boolean) || !e164) {
      focusFirst(form, found);
      return;
    }
    setPending(true);
    const result = await signUp({ name, email, password, phone: e164 });
    if (result.ok) {
      savePendingEmail({ email, next: safeRedirect(next) });
      router.push('/verify-email');
      return;
    }
    setPending(false);
    if (result.reason === 'REGISTRATION_CLOSED') return onClosed();
    if (result.reason === 'PASSWORD_TOO_COMMON') {
      setErrors({ password: t('validation.passwordCommon') });
      return;
    }
    setFailure(result.reason);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      <Field invalid={!!errors.name}>
        <FieldLabel>{t('fields.name')}</FieldLabel>
        <Input
          name="name"
          autoComplete="name"
          className="h-11 text-md"
          aria-invalid={!!errors.name}
        />
        <FieldError match={!!errors.name}>{errors.name}</FieldError>
      </Field>
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
        <FieldLabel>{t('fields.password')}</FieldLabel>
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
      <PhoneField
        country={country}
        onCountryChange={setCountry}
        value={phone}
        onValueChange={setPhone}
        error={errors.phone}
      />
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <Button type="submit" size="xl" disabled={pending}>
        {pending ? t('signUp.submitting') : t('signUp.submit')}
      </Button>
    </form>
  );
}
