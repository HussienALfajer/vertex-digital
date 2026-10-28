import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { AscentBar, Button } from '@vertex-digital/ui';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { reportClientError } from '../lib/report-error';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

function Message({ title, body, action }: { title: string; body?: string; action: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col items-start gap-4">
        <div className="flex items-center gap-3">
          <AscentBar />
          <h1 className="text-2xl font-bold">{title}</h1>
        </div>
        {body && <p className="text-muted-foreground">{body}</p>}
        {action}
      </div>
    </main>
  );
}

/** An error before the shell (the session read, the root itself): a full page, and Sentry. */
function RootError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  useEffect(() => reportClientError(error), [error]);
  return (
    <Message
      title={t('common.errorTitle')}
      body={t('common.errorBody')}
      action={<Button onClick={() => window.location.reload()}>{t('common.reload')}</Button>}
    />
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <Message
      title={t('common.notFoundTitle')}
      action={<Button render={<Link to="/" />}>{t('common.backHome')}</Button>}
    />
  );
}
