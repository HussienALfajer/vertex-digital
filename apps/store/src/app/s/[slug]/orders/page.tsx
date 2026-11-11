import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopOrdersList } from '@/features/shop/orders-list';
import { ShopRoute } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('orders.title') };

export default function ShopOrdersRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopOrdersList slug={slug} />} />;
}
