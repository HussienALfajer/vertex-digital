import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopNotFound } from '@/features/shop/not-found-view';

export const metadata: Metadata = {
  title: ts('notFound.title'),
  robots: { index: false, follow: false },
};

/** No shop at this slug (S26 screens): the store's 404 without the store's frame or links. */
export default function NoShop() {
  return (
    <main className="flex flex-1 flex-col">
      <ShopNotFound />
    </main>
  );
}
