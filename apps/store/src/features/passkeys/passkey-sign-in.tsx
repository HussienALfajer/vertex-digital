'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { FingerprintIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { tp } from './i18n';
import {
  type CeremonyFailure,
  passkeyAutofillSupported,
  passkeysSupported,
  signInWithPasskey,
} from './requests';

/** Every refused passkey says the same, as a refused password does (edge case 20). */
const failureText = (reason: CeremonyFailure) =>
  reason === 'CANCELLED'
    ? tp('signIn.cancelled')
    : reason === 'RATE_LIMITED' || reason === 'NETWORK'
      ? errorText(reason)
      : tp('signIn.failed');

/**
 * "الدخول بالبصمة" under the sign-in form (S22 PK3), and the browser's passkey suggestions on the
 * email field where it offers them (`autocomplete="email webauthn"`). Nothing shows without
 * WebAuthn (edge case 21). Loaded with `next/dynamic` by the sign-in form; `onSignedIn` takes the
 * customer where the form would.
 */
export function PasskeySignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [supported, setSupported] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CeremonyFailure | null>(null);

  useEffect(() => {
    setSupported(passkeysSupported());
    let active = true;
    // The suggestions wait for a pick; pressing the button replaces this ceremony. They are
    // passive: a refusal there says nothing, the button and the password stay.
    void passkeyAutofillSupported().then(async (available) => {
      if (!available || !active) return;
      const result = await signInWithPasskey({ autofill: true });
      if (active && result.ok) onSignedIn();
    });
    return () => {
      active = false;
    };
  }, [onSignedIn]);

  if (!supported) return null;

  const signIn = async () => {
    setFailure(null);
    setPending(true);
    const result = await signInWithPasskey();
    if (result.ok) return onSignedIn();
    setPending(false);
    setFailure(result.reason);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {tp('signIn.or')}
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button variant="outline" size="xl" disabled={pending} onClick={signIn}>
        <FingerprintIcon />
        {pending ? tp('signIn.pending') : tp('signIn.button')}
      </Button>
      {failure && <FormAlert>{failureText(failure)}</FormAlert>}
    </div>
  );
}
