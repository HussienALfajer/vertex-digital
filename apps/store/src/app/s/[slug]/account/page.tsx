import type { Metadata } from 'next';
import { ShopAccountPage } from '@/features/shop/account-page';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('account.title') };

export default function ShopAccountRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopAccountPage slug={slug} />} />;
}
