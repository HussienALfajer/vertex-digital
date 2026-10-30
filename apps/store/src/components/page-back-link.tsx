import { BackLink } from '@vertex-digital/ui/components/back-link';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** The store's `BackLink`: not prefetched, so an account page's forms stay out of first loads. */
export function PageBackLink({ href, children }: { href: string; children: ReactNode }) {
  return <BackLink render={<Link href={href} prefetch={false} />}>{children}</BackLink>;
}
