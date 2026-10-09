import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { OrderPage, OrderSkeleton } from '@/features/orders/order-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('orders.detail.title'),
  robots: { index: false },
};

/**
 * A static shell: the order loads in the browser with the session cookie, by the id in the URL
 * (known only at request time, hence the boundary), and is never cached (S08).
 */
export default function OrderRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('orders.detail.title')} />
      <Suspense fallback={<OrderSkeleton />}>
        <OrderPage />
      </Suspense>
    </div>
  );
}
