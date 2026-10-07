'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { currentPasswordError, focusFirst, newPasswordError } from '../auth/validation';
import { changePassword } from './requests';

/** Rule C11: the current password, then the new one; every other session is signed out. */
export function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const [errors, setErrors] = useState<{ currentPassword?: string; newPassword?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [changed, setChanged] = useState(false);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const found = {
      currentPassword: currentPasswordError(currentPassword),
      newPassword: newPasswordError(newPassword),
    };
    setErrors(found);
    setFailure(null);
    setChanged(false);
    if (found.currentPassword || found.newPassword) {
      focusFirst(form, found);
      return;
    }
    setPending(true);
    const result = await changePassword({ currentPassword, newPassword });
    setPending(false);
    if (result.ok) {
      form.reset();
      setChanged(true);
      onChanged();
      return;
    }
    if (result.reason === 'INVALID_PASSWORD') {
      setErrors({ currentPassword: errorText(result.reason) });
    } else if (result.reason === 'PASSWORD_TOO_COMMON') {
      setErrors({ newPassword: t('validation.passwordCommon') });
    } else setFailure(result.reason);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.password.title')}</CardTitle>
        <CardDescription>{t('account.password.description')}</CardDescription>
      </CardHeader>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field invalid={!!errors.currentPassword}>
          <FieldLabel>{t('fields.currentPassword')}</FieldLabel>
          <PasswordInput
            name="currentPassword"
            autoComplete="current-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!errors.currentPassword}
          />
          <FieldError match={!!errors.currentPassword}>{errors.currentPassword}</FieldError>
        </Field>
        <Field invalid={!!errors.newPassword}>
          <FieldLabel>{t('fields.newPassword')}</FieldLabel>
          <PasswordInput
            name="newPassword"
            autoComplete="new-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!errors.newPassword}
          />
          <FieldDescription>{t('fields.passwordHint')}</FieldDescription>
          <FieldError match={!!errors.newPassword}>{errors.newPassword}</FieldError>
        </Field>
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        {changed && <FormAlert tone="success">{t('account.password.changed')}</FormAlert>}
        <Button type="submit" size="xl" className="self-start" disabled={pending}>
          {pending ? t('account.password.submitting') : t('account.password.submit')}
        </Button>
      </form>
    </Card>
  );
}
