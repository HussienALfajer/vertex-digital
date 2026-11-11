import type { Metadata } from 'next';
import { ShopReset } from '@/features/shop/auth-forms';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('auth.resetTitle') };

export default function ShopResetRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopReset slug={slug} />} />;
}
