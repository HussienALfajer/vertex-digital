import type { Metadata } from 'next';
import { ts } from '@/features/shop/i18n';
import { ShopRoute } from '@/features/shop/shop-route';
import { ShopWalletPage } from '@/features/shop/wallet-page';

export const metadata: Metadata = { title: ts('wallet.title') };

export default function ShopWalletRoute({ params }: { params: Promise<{ slug: string }> }) {
  return <ShopRoute params={params} render={(slug) => <ShopWalletPage slug={slug} />} />;
}
