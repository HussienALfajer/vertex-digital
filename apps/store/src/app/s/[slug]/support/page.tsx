import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';
import { ShopTicketsList } from '@/features/shop/support-pages';

export const metadata: Metadata = { title: ts('support.title') };

export default function ShopSupportRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopTicketsList slug={slug} />} />;
}
