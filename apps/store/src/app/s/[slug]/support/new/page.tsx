import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';
import { ShopNewTicket } from '@/features/shop/support-pages';

export const metadata: Metadata = { title: ts('support.new') };

export default function ShopNewTicketRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopNewTicket slug={slug} />} />;
}
