'use client';

import dynamic from 'next/dynamic';
import { useMerchantAccount } from './sale-mode';

/** The page's star keeps its room from the merchant hint on, so nothing moves when it loads. */
function PagePlaceholder() {
  return <span aria-hidden="true" className="hidden h-11 w-28 [[data-merchant-hint]_&]:block" />;
}

const PinStar = dynamic(() => import('./pin-star').then((module) => module.PinStar), {
  loading: () => null,
});

const PagePinStar = dynamic(() => import('./pin-star').then((module) => module.PinStar), {
  loading: () => <PagePlaceholder />,
});

/**
 * Where a game's star goes (owner, 2026-10-30): nothing in the cached page and nothing at all for
 * a customer or a visitor; for a merchant, the star loaded in the browser. A card's star sits over
 * its cover (the card is `relative`), so it moves nothing either.
 */
export function PinStarSlot({
  gameId,
  gameName,
  variant,
}: {
  gameId: string;
  gameName: string;
  variant: 'card' | 'page';
}) {
  const account = useMerchantAccount();
  if (account === 'loading') return variant === 'page' ? <PagePlaceholder /> : null;
  if (account !== 'merchant') return null;
  return variant === 'page' ? (
    <PagePinStar gameId={gameId} gameName={gameName} variant="page" />
  ) : (
    <PinStar gameId={gameId} gameName={gameName} variant="card" />
  );
}
