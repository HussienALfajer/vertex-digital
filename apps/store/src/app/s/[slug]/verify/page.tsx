import type { Metadata } from 'next';
import { ShopVerify } from '@/features/shop/auth-forms';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('auth.verifyTitle') };

export default function ShopVerifyRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopVerify slug={slug} />} />;
}
