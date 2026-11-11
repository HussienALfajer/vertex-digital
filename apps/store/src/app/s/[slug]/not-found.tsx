import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopNotFound } from '@/features/shop/not-found-view';

export const metadata: Metadata = {
  title: ts('notFound.title'),
  robots: { index: false, follow: false },
};

/** A page of a known shop that is not there (a game, an order): inside the shop's frame. */
export default function ShopPageNotFound() {
  return <ShopNotFound />;
}
