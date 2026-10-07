import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { backupCodeSchema, type SignIn, signInSchema } from '@vertex-digital/contracts';
import { Button, Field, FieldError, FieldLabel, Input, PasswordInput } from '@vertex-digital/ui';
import { ArrowRightIcon, KeyRoundIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { AuthHeading, AuthLayout } from '../../components/auth-layout';
import { FormAlert } from '../../components/form-alert';
import { ALTCHA_HEADER, solveAltcha } from '../../lib/altcha';
import { authClient, needsTwoFactorSetup, sessionQuery } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { safeRedirect } from '../../lib/safe-redirect';
import { TotpForm } from './totp-form';

type Step = 'password' | 'totp' | 'backup';

/** Sign-in with the password, then the authenticator or a backup code (ADR 0007). */
export function LoginPage({ redirect }: { redirect?: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('password');

  /** Loads the new session, then goes where the user was heading (or sets up 2FA first). */
  async function enter() {
    // Replace the cached "no session" answer before the guarded route reads it.
    const session = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (session && needsTwoFactorSetup(session)) {
      await router.navigate({ to: '/setup-two-factor', replace: true });
      return;
    }
    await router.navigate({ href: safeRedirect(redirect), replace: true });
  }

  return (
    <AuthLayout>
      {step === 'password' && (
        <>
          <AuthHeading title={t('login.title')} subtitle={t('login.subtitle')} />
          <SignInForm onSignedIn={enter} onTwoFactor={() => setStep('totp')} />
        </>
      )}
      {step === 'totp' && (
        <>
          <AuthHeading
            title={t('login.twoFactor.title')}
            subtitle={t('login.twoFactor.subtitle')}
          />
          <TotpForm label={t('login.twoFactor.code')} autoFocus onVerified={enter} />
          <StepLinks
            onSwitch={() => setStep('backup')}
            switchLabel={t('login.twoFactor.useBackup')}
            switchIcon={<KeyRoundIcon />}
            onBack={() => setStep('password')}
          />
        </>
      )}
      {step === 'backup' && (
        <>
          <AuthHeading
            title={t('login.twoFactor.backupTitle')}
            subtitle={t('login.twoFactor.backupSubtitle')}
          />
          <BackupCodeForm onVerified={enter} />
          <StepLinks
            onSwitch={() => setStep('totp')}
            switchLabel={t('login.twoFactor.useApp')}
            switchIcon={<SmartphoneIcon />}
            onBack={() => setStep('password')}
          />
        </>
      )}
    </AuthLayout>
  );
}

function SignInForm({
  onSignedIn,
  onTwoFactor,
}: {
  onSignedIn: () => Promise<void>;
  onTwoFactor: () => void;
}) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignIn>({
    resolver: standardSchemaResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    let { data, error } = await authClient.signIn.email(values);
    // After repeated failures on this account the API asks for proof of work (ADR 0008): solve it
    // in the browser and send the same sign-in again, once.
    if (error?.code === 'ALTCHA_REQUIRED' || error?.code === 'ALTCHA_INVALID') {
      setVerifying(true);
      let altcha: string;
      try {
        altcha = await solveAltcha();
      } catch {
        setVerifying(false);
        setFailure(t('errors.ALTCHA_FAILED'));
        return;
      }
      setVerifying(false);
      ({ data, error } = await authClient.signIn.email(values, {
        headers: { [ALTCHA_HEADER]: altcha },
      }));
    }
    if (error) {
      // Wrong email and password together, or a block (account or address): about the whole form.
      setFailure(errorMessage(t, error));
      return;
    }
    // With 2FA enrolled, the admin gets a second step before the session exists.
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return onTwoFactor();
    await onSignedIn();
  });

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
      <Field invalid={!!errors.email}>
        <FieldLabel>{t('login.email')}</FieldLabel>
        <Input type="email" dir="ltr" autoComplete="username" autoFocus {...register('email')} />
        <FieldError match={!!errors.email}>{t('login.errors.email')}</FieldError>
      </Field>
      <Field invalid={!!errors.password}>
        <FieldLabel>{t('login.password')}</FieldLabel>
        <PasswordInput
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          autoComplete="current-password"
          {...register('password')}
        />
        <FieldError match={!!errors.password}>{t('login.errors.password')}</FieldError>
      </Field>
      {failure && <FormAlert>{failure}</FormAlert>}
      <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
        {verifying
          ? t('login.verifying')
          : isSubmitting
            ? t('login.submitting')
            : t('login.submit')}
      </Button>
    </form>
  );
}

function BackupCodeForm({ onVerified }: { onVerified: () => Promise<void> }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = backupCodeSchema.safeParse(code);
    if (!parsed.success) return setFailure(t('login.twoFactor.backupError'));
    setFailure(null);
    setPending(true);
    const { error } = await authClient.twoFactor.verifyBackupCode({ code: parsed.data });
    if (error) {
      setPending(false);
      return setFailure(errorMessage(t, error));
    }
    await onVerified();
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <Field invalid={!!failure}>
        <FieldLabel>{t('login.twoFactor.backupCode')}</FieldLabel>
        <Input
          dir="ltr"
          className="text-center text-lg tabular-nums"
          autoComplete="one-time-code"
          // Codes are compared exactly: phone keyboards must not capitalise or correct them.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <FieldError match={!!failure} role="alert">
          {failure}
        </FieldError>
      </Field>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? t('login.twoFactor.submitting') : t('login.twoFactor.submit')}
      </Button>
    </form>
  );
}

function StepLinks({
  onSwitch,
  switchLabel,
  switchIcon,
  onBack,
}: {
  onSwitch: () => void;
  switchLabel: string;
  switchIcon: React.ReactNode;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
      <Button variant="ghost" size="sm" onClick={onSwitch}>
        {switchIcon}
        {switchLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowRightIcon className="ltr:-scale-x-100" />
        {t('login.twoFactor.back')}
      </Button>
    </div>
  );
}
