import type { Metadata } from 'next';
import { ShopSignIn } from '@/features/shop/auth-forms';
import { ts } from '@/features/shop/i18n';
import { ShopWithData } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('auth.signInTitle') };

export default function ShopSignInRoute({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <ShopWithData
      params={params}
      render={(shop) => (
        <ShopSignIn slug={shop.slug} name={shop.name} signUp={shop.status === 'active'} />
      )}
    />
  );
}
