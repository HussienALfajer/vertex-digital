import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { StoreIcon } from 'lucide-react';
import Link from 'next/link';
import { tsa } from './i18n';

/** "متجري"'s other pages before the shop is approved: the way to its request. */
export function NoShop() {
  return (
    <EmptyState
      icon={<StoreIcon />}
      title={tsa('common.noShop')}
      action={
        <Button
          variant="outline"
          size="xl"
          render={<Link href="/merchant/shop" prefetch={false} />}
        >
          {tsa('common.toShop')}
        </Button>
      }
    />
  );
}
