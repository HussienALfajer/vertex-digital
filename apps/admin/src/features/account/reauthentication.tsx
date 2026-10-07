import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { type Reauthenticate, reauthenticateSchema } from '@vertex-digital/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  OtpField,
  PasswordInput,
} from '@vertex-digital/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
} from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorCode, errorMessage } from '../../lib/errors';
import { reauthenticate } from './account.queries';

/** Runs an admin action; when the API asks for re-authentication first, asks, then runs it again. */
type WithReauthentication = <T>(action: () => Promise<T>) => Promise<T>;

const ReauthenticationContext = createContext<WithReauthentication | null>(null);

const isReauthenticationRequired = (error: unknown) =>
  error instanceof ApiError && error.code === 'REAUTHENTICATION_REQUIRED';

/**
 * Re-authentication for sensitive actions (rule D5): an action refused with
 * `REAUTHENTICATION_REQUIRED` opens the dialog (password and authenticator code; backup codes are
 * not accepted), and is retried once it succeeds. Cancelling leaves the action refused.
 */
export function ReauthenticationProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    pending.current?.(confirmed);
    pending.current = null;
    setOpen(false);
  }, []);

  const withReauthentication = useCallback<WithReauthentication>(async (action) => {
    try {
      return await action();
    } catch (error) {
      if (!isReauthenticationRequired(error)) throw error;
      const confirmed = await new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      });
      if (!confirmed) throw error;
      return action();
    }
  }, []);

  return (
    <ReauthenticationContext value={withReauthentication}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && settle(false)}>
        {open && <ReauthenticationDialog onConfirmed={() => settle(true)} />}
      </Dialog>
    </ReauthenticationContext>
  );
}

/** Runs the action as it is. */
const direct: WithReauthentication = (action) => action();

/**
 * Wraps an admin action so a sensitive one asks for re-authentication first (rule D5). Outside the
 * shell (the forced password change) actions run as they are: those are setup routes, which the
 * API never marks sensitive.
 */
export function useReauthentication(): WithReauthentication {
  return useContext(ReauthenticationContext) ?? direct;
}

function ReauthenticationDialog({ onConfirmed }: { onConfirmed: () => void }) {
  const { t } = useTranslation();
  const codeId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<Reauthenticate>({
    resolver: standardSchemaResolver(reauthenticateSchema),
    defaultValues: { password: '', totpCode: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await reauthenticate(values);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'INVALID_PASSWORD') {
        return setError('password', { type: 'server', message: errorMessage(t, error) });
      }
      if (code === 'INVALID_CODE') {
        resetField('totpCode');
        return setError('totpCode', { type: 'server', message: errorMessage(t, error) });
      }
      return setFailure(errorMessage(t, error));
    }
    onConfirmed();
  });

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('reauth.title')}</DialogTitle>
        <DialogDescription>{t('reauth.subtitle')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field invalid={!!errors.password}>
          <FieldLabel>{t('reauth.password')}</FieldLabel>
          <PasswordInput
            showLabel={t('common.showPassword')}
            hideLabel={t('common.hidePassword')}
            autoComplete="current-password"
            autoFocus
            {...register('password')}
          />
          <FieldError match={!!errors.password}>
            {errors.password?.type === 'server'
              ? errors.password.message
              : t('reauth.errors.password')}
          </FieldError>
        </Field>
        <Field invalid={!!errors.totpCode}>
          <FieldLabel htmlFor={codeId}>{t('reauth.code')}</FieldLabel>
          <Controller
            control={control}
            name="totpCode"
            render={({ field }) => (
              <OtpField
                id={codeId}
                value={field.value}
                onValueChange={field.onChange}
                slotLabel={(position) => t('twoFactorSetup.digit', { position })}
                aria-invalid={errors.totpCode ? true : undefined}
              />
            )}
          />
          <FieldError match={!!errors.totpCode} role="alert">
            {errors.totpCode?.type === 'server' ? errors.totpCode.message : t('reauth.errors.code')}
          </FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('reauth.submitting') : t('reauth.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
