'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { MailQuestionIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { CodeInput } from './code-input';
import { clearPendingEmail, type PendingEmail, readPendingEmail } from './pending-email';
import { sendVerificationCode, verifyEmail } from './requests';
import { FormSkeleton } from './sign-up-panel';
import { useCountdown } from './use-countdown';
import { codeError } from './validation';

/**
 * The email code after sign-up or an unverified sign-in (rules C4, C7): the right code signs the
 * customer in and goes back where they were heading.
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
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const countdown = useCountdown(60);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = codeError(code);
    setCodeFailure(invalid);
    setFailure(null);
    setNotice(false);
    if (invalid) return;
    setSubmitting(true);
    const result = await verifyEmail(email, code);
    if (result.ok) {
      clearPendingEmail();
      // A full load, so everything rendered for a signed-out visitor is read again.
      window.location.assign(next);
      return;
    }
    setSubmitting(false);
    if (result.reason === 'INVALID_OTP') setCodeFailure(errorText(result.reason));
    else setFailure(result.reason);
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
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        <CodeInput value={code} onValueChange={setCode} error={codeFailure} autoFocus />
        {/* An expired or voided code says to request a new one (rule C4). */}
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        {notice && <FormAlert tone="success">{t('verifyEmail.resent')}</FormAlert>}
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
          <Button variant="ghost" size="xl" render={<Link href="/sign-up" />}>
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
