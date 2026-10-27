import type { RichLink } from '@vertex-digital/ui/components/rich-text';
import Link from 'next/link';

/**
 * A link inside a page body or an FAQ answer (S14 MD5): a client navigation instead of a whole
 * page load (audit A08-42), never prefetched, as the footer's links (store rule).
 */
export const ContentLink: RichLink = ({ href, className, children }) => (
  <Link href={href} prefetch={false} className={className}>
    {children}
  </Link>
);
