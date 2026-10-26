import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQueryClient } from '@tanstack/react-query';
import {
  type AdminChangePassword,
  adminChangePasswordSchema,
  PASSWORD_EQUALS_EMAIL,
  PASSWORD_TOO_COMMON,
  PASSWORD_UNCHANGED,
  passwordEqualsEmail,
} from '@vertex-digital/contracts';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  PasswordInput,
  useFocusInvalid,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { type FieldError as FormFieldError, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { sessionQuery } from '../../lib/auth';
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

/** The API's refusal of a new password equal to the admin's email (rule D6). */
const equalsEmail = (error: unknown) =>
  error instanceof ApiError &&
  Array.isArray(error.details) &&
  error.details.some((detail: { message?: unknown }) => detail?.message === PASSWORD_EQUALS_EMAIL);

/** The message for a refused new password: what to change, by the contract's issue. */
function newPasswordMessage(t: TFunction, error: FormFieldError | undefined): string | undefined {
  if (!error) return undefined;
  if (error.message === PASSWORD_TOO_COMMON) return t('changePassword.errors.common');
  if (error.message === PASSWORD_UNCHANGED) return t('changePassword.errors.unchanged');
  if (error.message === PASSWORD_EQUALS_EMAIL) return t('changePassword.errors.equalsEmail');
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
  const queryClient = useQueryClient();
  const changePassword = useChangePassword();
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
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

  const onSubmit = handleSubmit(
    async ({ currentPassword, newPassword }) => {
      setFailure(null);
      // Rule D6: not the account's email, checked before sending as the API checks it (A01-23).
      const email = queryClient.getQueryData(sessionQuery.queryKey)?.user.email;
      if (email && passwordEqualsEmail(newPassword, email)) {
        setError('newPassword', { message: PASSWORD_EQUALS_EMAIL });
        return focusInvalid();
      }
      try {
        await changePassword.mutateAsync({ currentPassword, newPassword });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'INVALID_PASSWORD') {
          setError('currentPassword', { type: 'server', message: errorMessage(t, error) });
          return focusInvalid();
        }
        if (code === 'PASSWORD_TOO_COMMON') {
          setError('newPassword', { message: PASSWORD_TOO_COMMON });
          return focusInvalid();
        }
        if (code === 'VALIDATION_FAILED' && equalsEmail(error)) {
          setError('newPassword', { message: PASSWORD_EQUALS_EMAIL });
          return focusInvalid();
        }
        return setFailure(errorMessage(t, error));
      } finally {
        // The typed passwords leave the mutation cache (A01-25).
        changePassword.reset();
      }
      reset();
      await onChanged();
    },
    () => focusInvalid(),
  );

  return (
    <form ref={ref} className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
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
      <InvalidAlert show={Object.keys(errors).length > 0} />
      <Button type="submit" size="lg" className={submitClassName} disabled={isSubmitting}>
        {isSubmitting ? t('changePassword.submitting') : t('changePassword.submit')}
      </Button>
    </form>
  );
}
