import type { Metadata } from 'next';
import { ShopSignUp } from '@/features/shop/auth-forms';
import { ts } from '@/features/shop/i18n';
import { ShopWithData } from '@/features/shop/shop-route';

export const metadata: Metadata = { title: ts('auth.signUpTitle') };

/** CA2: sign-up only while the shop is active (SH6, SH7). */
export default function ShopSignUpRoute({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <ShopWithData
      params={params}
      render={(shop) => (
        <ShopSignUp slug={shop.slug} name={shop.name} accepting={shop.status === 'active'} />
      )}
    />
  );
}
