import { type ReactNode, Suspense } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { FrozenBanner } from '@/components/frozen-banner';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { StopBanner } from '@/components/stop-banner';
import { SiteAnnouncement } from '@/features/content/announcement';

/** The store's frame on every page but a merchant's shop (`/s/[slug]`, S26). */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {/* Read in the browser on every page (audit A09-22): `usePathname` needs a boundary. */}
      <Suspense fallback={null}>
        <StopBanner />
        <FrozenBanner />
      </Suspense>
      <Suspense fallback={null}>
        <SiteAnnouncement />
      </Suspense>
      <main className="flex flex-1 flex-col">{children}</main>
      <SiteFooter />
      <BottomNav />
    </>
  );
}
