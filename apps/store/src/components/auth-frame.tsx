import { AscentLines } from '@vertex-digital/ui/brand/ascent-lines';
import { VertexLogo } from '@vertex-digital/ui/brand/logo';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { ListChecksIcon, WalletIcon, ZapIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';

const POINTS = [
  { icon: ZapIcon, text: 'auth.points.fast' },
  { icon: WalletIcon, text: 'auth.points.wallet' },
  { icon: ListChecksIcon, text: 'auth.points.tracking' },
] as const;

/**
 * The frame of the account entry screens (sign-in, sign-up, the email code, forgot password;
 * 2026-10-15, F2-5): one card with a brand panel, the sand logo on Vertex Green with
 * the 60° hairlines (brand/identity.md §5, §8), beside the form. On a phone the panel is a short
 * band above the form; from `md` it is the card's start column with three plain promises.
 */
export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8 md:max-w-4xl md:py-14">
      <div className="overflow-hidden rounded-xl border border-border bg-surface md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <aside className="relative overflow-hidden bg-green-800 px-6 py-5 md:flex md:flex-col md:justify-between md:gap-10 md:p-10">
          <AscentLines className="absolute inset-y-0 end-0 h-full w-1/2 text-gold-400 opacity-15" />
          <div className="relative flex items-center gap-4 md:flex-col md:items-start md:gap-6">
            <VertexLogo className="w-14 text-gold-400 md:w-28" />
            <p className="text-base text-neutral-100 md:text-lg">{t('auth.tagline')}</p>
          </div>
          <ul className="relative hidden flex-col gap-4 md:flex">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-neutral-200">
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-gold-400" />
                {t(text)}
              </li>
            ))}
          </ul>
        </aside>
        <div className="flex flex-col gap-8 px-5 py-8 md:px-10 md:py-10">
          <PageHeader title={title} description={description} />
          {children}
        </div>
      </div>
    </div>
  );
}
