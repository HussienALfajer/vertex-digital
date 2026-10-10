import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { CartPage } from '@/features/cart/cart-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('cart.title'),
  robots: { index: false },
};

/** The cart (S10 rules CT4–CT6): a static shell, the lines come from the device. */
export default function CartRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('cart.title')} description={t('cart.subtitle')} />
      <CartPage />
    </div>
  );
}
