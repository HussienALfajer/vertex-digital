'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { DoorClosedIcon } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { withNext } from '@/lib/safe-redirect';
import { useSearchParam } from '@/lib/use-search-param';
import { registrationState } from './requests';
import { SignUpForm } from './sign-up-form';
import { useLeaveIfSignedIn } from './use-leave-if-signed-in';

/**
 * The sign-up form while registration is open, with the terms sentence rendered by the server
 * (`terms`, S14); a calm "opens soon" otherwise (rule C16), with no terms to agree to (A01-14).
 */
export function SignUpPanel({ terms }: { terms: ReactNode }) {
  const next = useSearchParam('next');
  const [state, setState] = useState<'loading' | 'open' | 'closed' | 'failed'>('loading');
  useLeaveIfSignedIn();

  const read = useCallback(() => {
    setState('loading');
    void registrationState().then(setState);
  }, []);

  useEffect(read, [read]);

  if (state === 'loading') return <FormSkeleton fields={4} />;
  // Not known (no connection, a rate limit): never shown as "closed".
  if (state === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert>{errorText('NETWORK')}</FormAlert>
        <Button variant="outline" size="xl" onClick={read}>
          {t('signUp.retry')}
        </Button>
      </div>
    );
  }
  if (state === 'closed') {
    return (
      <EmptyState
        icon={<DoorClosedIcon />}
        title={t('signUp.closedTitle')}
        description={t('signUp.closedBody')}
        action={
          <Button variant="outline" size="xl" render={<Link href={withNext('/sign-in', next)} />}>
            {t('signUp.signInLink')}
          </Button>
        }
      />
    );
  }
  return (
    <>
      <SignUpForm onClosed={() => setState('closed')} />
      <p className="text-center text-sm text-muted-foreground">
        {t('signUp.haveAccount')}{' '}
        <Link
          href={withNext('/sign-in', next)}
          className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline"
        >
          {t('signUp.signInLink')}
        </Link>
      </p>
      {terms}
    </>
  );
}

/** A form's shape while it loads: a label and a field per row, then the button. */
export function FormSkeleton({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-5" aria-hidden="true">
      {Array.from({ length: fields }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity.
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
      <Skeleton className="h-12 w-full" />
    </div>
  );
}
