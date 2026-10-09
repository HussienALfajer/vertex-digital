import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { OrdersList } from '@/features/orders/orders-list';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('orders.title'),
  robots: { index: false },
};

/** "طلباتي": read in the browser with the session cookie and never cached (S08). */
export default function OrdersRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('orders.title')} description={t('orders.subtitle')} />
      <OrdersList />
    </div>
  );
}
