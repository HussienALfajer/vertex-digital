import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import {
  type AdminChangePassword,
  adminChangePasswordSchema,
  PASSWORD_TOO_COMMON,
  PASSWORD_UNCHANGED,
} from '@vertex-digital/contracts';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  PasswordInput,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { type FieldError as FormFieldError, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorCode, errorMessage } from '../../lib/errors';
import { useChangePassword } from './account.queries';

/** The contract's rules (rule D6), and the new password typed a second time. */
const formSchema = adminChangePasswordSchema
  .safeExtend({ confirmPassword: adminChangePasswordSchema.shape.currentPassword })
  .refine((value) => value.confirmPassword === value.newPassword, {
    path: ['confirmPassword'],
    message: 'PASSWORD_MISMATCH',
  });

type FormValues = AdminChangePassword & { confirmPassword: string };

/** The message for a refused new password: what to change, by the contract's issue. */
function newPasswordMessage(t: TFunction, error: FormFieldError | undefined): string | undefined {
  if (!error) return undefined;
  if (error.message === PASSWORD_TOO_COMMON) return t('changePassword.errors.common');
  if (error.message === PASSWORD_UNCHANGED) return t('changePassword.errors.unchanged');
  if (error.type === 'too_big') return t('changePassword.errors.long');
  return t('changePassword.errors.short');
}

/**
 * The admin's password change (rules D1, D6, D7): forced after a CLI-issued password, and on the
 * account page. Every other session is signed out.
 */
export function ChangePasswordForm({
  onChanged,
  submitClassName,
}: {
  onChanged: () => Promise<void> | void;
  submitClassName?: string;
}) {
  const { t } = useTranslation();
  const changePassword = useChangePassword();
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: standardSchemaResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    setFailure(null);
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'INVALID_PASSWORD') {
        return setError('currentPassword', { type: 'server', message: errorMessage(t, error) });
      }
      if (code === 'PASSWORD_TOO_COMMON') {
        return setError('newPassword', { message: PASSWORD_TOO_COMMON });
      }
      return setFailure(errorMessage(t, error));
    }
    reset();
    await onChanged();
  });

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
      <Field invalid={!!errors.currentPassword}>
        <FieldLabel>{t('changePassword.current')}</FieldLabel>
        <PasswordInput
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        <FieldError match={!!errors.currentPassword}>
          {errors.currentPassword?.type === 'server'
            ? errors.currentPassword.message
            : t('changePassword.errors.current')}
        </FieldError>
      </Field>
      <Field invalid={!!errors.newPassword}>
        <FieldLabel>{t('changePassword.new')}</FieldLabel>
        <PasswordInput
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          autoComplete="new-password"
          {...register('newPassword')}
        />
        <FieldDescription>{t('changePassword.hint')}</FieldDescription>
        <FieldError match={!!errors.newPassword}>
          {newPasswordMessage(t, errors.newPassword)}
        </FieldError>
      </Field>
      <Field invalid={!!errors.confirmPassword}>
        <FieldLabel>{t('changePassword.confirm')}</FieldLabel>
        <PasswordInput
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          autoComplete="new-password"
          {...register('confirmPassword')}
        />
        <FieldError match={!!errors.confirmPassword}>
          {t('changePassword.errors.mismatch')}
        </FieldError>
      </Field>
      {failure && <FormAlert>{failure}</FormAlert>}
      <Button type="submit" size="lg" className={submitClassName} disabled={isSubmitting}>
        {isSubmitting ? t('changePassword.submitting') : t('changePassword.submit')}
      </Button>
    </form>
  );
}
