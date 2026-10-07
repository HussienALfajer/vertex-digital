import { totpCodeSchema } from '@vertex-digital/contracts';
import { Button, Field, FieldError, FieldLabel, OtpField } from '@vertex-digital/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';

/**
 * The 6-digit code from the authenticator app, checked as soon as it is complete: at sign-in
 * and when setting up 2FA. A refused code is the field's error, the slots empty and
 * the focus goes back to the first one.
 */
export function TotpForm({
  label,
  autoFocus,
  onVerified,
}: {
  label: string;
  autoFocus?: boolean;
  onVerified: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Checking disables the slots, which drops the focus: give it back after a wrong code.
  useEffect(() => {
    if (failure && !pending) document.getElementById(id)?.focus();
  }, [failure, pending, id]);

  async function verify(value: string) {
    if (!totpCodeSchema.safeParse(value).success || pending) return;
    setFailure(null);
    setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: value });
    if (error) {
      setPending(false);
      setCode('');
      return setFailure(errorMessage(t, error));
    }
    await onVerified();
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void verify(code);
      }}
    >
      <Field invalid={!!failure}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <OtpField
          id={id}
          autoFocus={autoFocus}
          value={code}
          onValueChange={setCode}
          onValueComplete={(value) => void verify(value)}
          slotLabel={(position) => t('twoFactorSetup.digit', { position })}
          disabled={pending}
          aria-invalid={failure ? true : undefined}
        />
        {/* Server answers arrive after the typing: announce them. */}
        <FieldError match={!!failure} role="alert">
          {failure}
        </FieldError>
      </Field>
      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={pending || !totpCodeSchema.safeParse(code).success}
      >
        {pending ? t('login.twoFactor.submitting') : t('login.twoFactor.submit')}
      </Button>
    </form>
  );
}
