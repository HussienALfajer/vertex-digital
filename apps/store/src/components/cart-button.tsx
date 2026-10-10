'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { ShoppingCartIcon } from 'lucide-react';
import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { storedLineCount, subscribeCart } from '@/features/cart/cart-keys';
import { t } from '@/lib/i18n';

/**
 * The header's cart (S10 screens): the line count as a badge from 1. Hidden while rendering on the
 * server and in a browser without storage, where the cart is off (rule CT1).
 */
export function CartButton() {
  const count = useSyncExternalStore(subscribeCart, storedLineCount, () => null);
  if (count === null) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={count > 0 ? t('header.cartCount', { count }) : t('header.cart')}
      render={<Link href="/cart" prefetch={false} />}
    >
      <ShoppingCartIcon />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-accent-foreground tabular-nums"
        >
          {count}
        </span>
      )}
    </Button>
  );
}
