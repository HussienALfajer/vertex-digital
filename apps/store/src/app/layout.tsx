import { DirectionProvider } from '@vertex-digital/ui/components/direction-provider';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { StopBanner } from '@/components/stop-banner';
import { t } from '@/lib/i18n';
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
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Dark by default (brand/identity.md §6); THEME_SCRIPT removes `dark` for a saved light choice
    // before paint, so React must not warn that the class differs from the server's.
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <DirectionProvider direction="rtl">
          <SiteHeader />
          <StopBanner />
          <main className="flex flex-1 flex-col">{children}</main>
          <SiteFooter />
        </DirectionProvider>
      </body>
    </html>
  );
}
