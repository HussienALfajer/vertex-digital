import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { MerchantNav } from '@/features/merchant-tools/merchant-nav';

export const metadata: Metadata = {
  title: tm('title'),
  robots: { index: false },
};

/** S21: the merchant area's frame; everything about the merchant loads in the browser. */
export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 md:py-16">
      <PageHeader title={tm('title')} description={tm('subtitle')} />
      <MerchantNav />
      {children}
    </div>
  );
}
