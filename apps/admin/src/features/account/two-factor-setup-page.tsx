import { useQueryClient } from '@tanstack/react-query';
import { useBlocker, useRouter } from '@tanstack/react-router';
import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldError,
  FieldLabel,
  PasswordInput,
  toast,
} from '@vertex-digital/ui';
import { CheckIcon, CopyIcon, LogOutIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthHeading, AuthLayout } from '../../components/auth-layout';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { authClient, sessionQuery } from '../../lib/auth';
import { useCopy } from '../../lib/clipboard';
import { type Failure, passwordFailure } from '../../lib/errors';
import { BackupCodes } from './backup-codes';
import { TotpForm } from './totp-form';

type Step = 'password' | 'scan' | 'codes';
const STEPS: Step[] = ['password', 'scan', 'codes'];

interface Enrollment {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Sets up TOTP two-factor sign-in, mandatory for the admin (ADR 0007): password, authenticator app,
 * backup codes.
 */
export function TwoFactorSetupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('password');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await router.navigate({ to: '/login' });
  }

  return (
    <AuthLayout wide>
      <AuthHeading title={t('twoFactorSetup.title')} subtitle={t('twoFactorSetup.subtitle')} />
      <Stepper current={step} />

      {step === 'password' && (
        <PasswordStep
          onEnrolled={(next) => {
            setEnrollment(next);
            setStep('scan');
          }}
        />
      )}
      {step === 'scan' && enrollment && (
        <ScanStep
          totpURI={enrollment.totpURI}
          onVerified={async () => {
            // Reload the session now: the app guard reads it on the next navigation.
            await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
            setStep('codes');
          }}
        />
      )}
      {step === 'codes' && enrollment && (
        <CodesStep
          codes={enrollment.backupCodes}
          onFinish={async () => {
            toast.add({ title: t('twoFactorSetup.enabled'), type: 'success' });
            await router.navigate({ to: '/' });
          }}
        />
      )}

      {/* Once the codes show, 2FA is on: the only way on is past them. */}
      {step !== 'codes' && (
        <Button variant="ghost" size="sm" className="self-start" onClick={signOut}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('twoFactorSetup.signOut')}
        </Button>
      )}
    </AuthLayout>
  );
}

/** Three stages drawn as rising bars, like the strokes of the mark (§5). */
function Stepper({ current }: { current: Step }) {
  const { t } = useTranslation();
  const index = STEPS.indexOf(current);
  const label = useRef<HTMLParagraphElement>(null);
  const shown = useRef(current);
  // The finished step's form is gone with its focus: start the next step from its label.
  useEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    label.current?.focus();
  }, [current]);
  return (
    <div className="flex flex-col gap-2">
      <p ref={label} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
        {t('twoFactorSetup.stepOf', { step: index + 1, total: STEPS.length })}
        {' · '}
        <span className="font-medium text-foreground">{t(`twoFactorSetup.steps.${current}`)}</span>
      </p>
      <ol className="flex items-end gap-1.5" aria-hidden="true">
        {STEPS.map((step, position) => (
          <li
            key={step}
            className={cn(
              'flex-1 rounded-sm transition-colors duration-250 ease-out',
              position === 0 ? 'h-1.5' : position === 1 ? 'h-2' : 'h-2.5',
              position <= index ? 'bg-accent' : 'bg-muted',
            )}
          />
        ))}
      </ol>
    </div>
  );
}

function PasswordStep({ onEnrolled }: { onEnrolled: (enrollment: Enrollment) => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    setPending(true);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (error || !data || !('totpURI' in data)) {
      const refused = passwordFailure(t, error);
      setFailure(refused);
      if (refused.field) passwordInput.current?.focus();
      return;
    }
    onEnrolled({ totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <p className="text-muted-foreground">{t('twoFactorSetup.passwordIntro')}</p>
      <Field invalid={failure?.field}>
        <FieldLabel>{t('twoFactorSetup.password')}</FieldLabel>
        <PasswordInput
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          autoComplete="current-password"
          autoFocus
          ref={passwordInput}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FieldError match={!!failure?.field} role="alert">
          {failure?.message}
        </FieldError>
      </Field>
      {failure && !failure.field && <FormAlert>{failure.message}</FormAlert>}
      <Button type="submit" size="lg" className="w-full" disabled={pending || !password}>
        {pending ? t('twoFactorSetup.starting') : t('twoFactorSetup.start')}
      </Button>
    </form>
  );
}

/** The secret in groups of four, easier to type into an app by hand. */
function groupKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

function ScanStep({ totpURI, onVerified }: { totpURI: string; onVerified: () => Promise<void> }) {
  const { t } = useTranslation();
  const { copy, copied } = useCopy();
  const secret = new URL(totpURI).searchParams.get('secret') ?? '';

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground">{t('twoFactorSetup.scanIntro')}</p>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {/* Scanners need dark modules on a light ground, in both themes. */}
        <div className="shrink-0 rounded-lg border border-border bg-white p-3">
          <QRCodeSVG
            value={totpURI}
            size={168}
            role="img"
            aria-label={t('twoFactorSetup.qrLabel')}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('twoFactorSetup.manualKey')}</p>
          <span
            dir="ltr"
            className="rounded-md bg-muted px-3 py-2 text-center text-sm font-medium break-all tabular-nums select-all"
          >
            {groupKey(secret)}
          </span>
          <Button variant="outline" size="sm" className="self-start" onClick={() => copy(secret)}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? t('common.copied') : t('twoFactorSetup.copyKey')}
          </Button>
        </div>
      </div>
      <TotpForm label={t('twoFactorSetup.code')} onVerified={onVerified} />
    </div>
  );
}

function CodesStep({ codes, onFinish }: { codes: string[]; onFinish: () => Promise<void> }) {
  const { t } = useTranslation();
  const savedId = useId();
  const [saved, setSaved] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // The codes are shown once: leaving before saving them (back, reload, closing the tab) asks first.
  const blocker = useBlocker({
    shouldBlockFn: () => !saved,
    enableBeforeUnload: () => !saved,
    withResolver: true,
  });
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground">{t('twoFactorSetup.codesIntro')}</p>
      <BackupCodes codes={codes} />
      <label
        htmlFor={savedId}
        className="flex cursor-pointer items-center gap-3 text-sm font-medium"
      >
        <Checkbox id={savedId} checked={saved} onCheckedChange={(value) => setSaved(value)} />
        {t('twoFactorSetup.confirmSaved')}
      </label>
      <Button
        size="lg"
        className="w-full"
        disabled={!saved || finishing}
        onClick={() => {
          setFinishing(true);
          void onFinish();
        }}
      >
        {t('twoFactorSetup.finish')}
      </Button>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title={t('twoFactorSetup.leaveCodes.title')}
        body={t('twoFactorSetup.leaveCodes.body')}
        action={t('twoFactorSetup.leaveCodes.leave')}
        destructive
        pending={false}
        onConfirm={async () => blocker.proceed?.()}
      />
    </div>
  );
}
