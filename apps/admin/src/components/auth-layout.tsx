import { AscentLines, cn, VertexLogo } from '@vertex-digital/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeToggle } from './theme-toggle';

/**
 * The frame of the screens outside the app shell (sign-in, 2FA setup): the form on
 * one side, the full logo in sand on Vertex Green on the other (approved colorway, §8).
 */
export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="relative grid min-h-dvh bg-background md:grid-cols-2">
      <ThemeToggle className="absolute top-4 start-4 z-10" />
      <main className="flex items-center justify-center px-6 py-12">
        <div className={cn('flex w-full flex-col gap-8', wide ? 'max-w-md' : 'max-w-sm')}>
          <VertexLogo label={t('app.brand')} className="w-28 text-primary md:hidden" />
          {children}
        </div>
      </main>
      <aside className="relative hidden flex-col items-center justify-center gap-8 overflow-hidden bg-sidebar p-12 md:flex">
        <AscentLines className="absolute inset-y-0 end-0 h-full w-1/4 text-sidebar-marker opacity-20" />
        <VertexLogo label={t('app.brand')} className="relative w-56 text-sidebar-marker" />
        <p className="relative text-center text-lg text-sidebar-muted-foreground">
          {t('app.tagline')}
        </p>
      </aside>
    </div>
  );
}

/** The title block of an auth screen. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl font-bold">{title}</h1>
      {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
    </div>
  );
}
