import { notFound } from 'next/navigation';

/**
 * Any other address under a shop (`/s/<slug>/xyz`, a mistyped or cut link): the shop's own 404
 * inside its frame, never the store's root 404 with the store's header and links (decision 12).
 */
export default function ShopUnknownPage(): never {
  notFound();
}
