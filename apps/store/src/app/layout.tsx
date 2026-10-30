import { DirectionProvider } from '@vertex-digital/ui/components/direction-provider';
import { themeHex } from '@vertex-digital/ui/theme-hex';
import type { Metadata, Viewport } from 'next';
import { type ReactNode, Suspense } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { FrozenBanner } from '@/components/frozen-banner';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { StopBanner } from '@/components/stop-banner';
import { SiteAnnouncement } from '@/features/content/announcement';
import { REGISTRATION_SCRIPT } from '@/features/pwa/registration';
import { APP_NAME } from '@/features/pwa/service-worker';
import { t } from '@/lib/i18n';
import { SESSION_HINT_SCRIPT } from '@/lib/session';
import { THEME_SCRIPT } from '@/lib/theme';
// The brand files stay in brand/ (their single home); the build copies them with hashed names.
import appleTouchIcon from '../../../../brand/logo/png/apple-touch-icon.png';
import favicon from '../../../../brand/logo/svg/favicon.svg';
import './globals.css';
// The Madani Arabic faces when the licensed files exist at build time (next.config.ts).
import 'vertex-madani-fonts';

export const metadata: Metadata = {
  title: { default: t('app.title'), template: `%s · ${t('app.name')}` },
  description: t('app.description'),
  icons: { icon: favicon.src, apple: appleTouchIcon.src },
  // S15 PW2: an installed iPhone app opens full screen under a dark status bar. Next writes the
  // standard `mobile-web-app-capable`; older iOS reads only the Apple name.
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: 'black' },
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
  // The dark theme's app background, as the manifest (PW1).
  themeColor: themeHex['green-950'],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Dark by default (brand/identity.md §6); THEME_SCRIPT removes `dark` for a saved light choice
    // and SESSION_HINT_SCRIPT may add `data-signed-in-hint` before paint, so React must not warn
    // that the element differs from the server's.
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input (S15 SW2). */}
        <script dangerouslySetInnerHTML={{ __html: REGISTRATION_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input. */}
        <script dangerouslySetInnerHTML={{ __html: SESSION_HINT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0 print:pb-0">
        <DirectionProvider direction="rtl">
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
        </DirectionProvider>
      </body>
    </html>
  );
}
