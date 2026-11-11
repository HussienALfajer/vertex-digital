import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopNotificationsPage } from '@/features/shop/notifications-page';
import { ShopRoute } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('notifications.title') };

export default function ShopNotificationsRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopNotificationsPage slug={slug} />} />;
}
