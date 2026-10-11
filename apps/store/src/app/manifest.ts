import type { MetadataRoute } from 'next';
import { APP_NAME } from '@/features/pwa/service-worker';
import { t } from '@/lib/i18n';
// The brand files stay in brand/ (their single home); the build copies them with hashed names.
import icon192 from '../../../../brand/logo/png/icon-192.png';
import icon512 from '../../../../brand/logo/png/icon-512.png';
import maskable from '../../../../brand/logo/png/icon-maskable-512.png';

/** The dark theme's app background (brand/identity.md §2): the installed app's splash and bars. */
const BACKGROUND = '#031B17';

/** `/manifest.webmanifest` (S15 PW1): the installable store. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'ar',
    dir: 'rtl',
    name: APP_NAME,
    short_name: APP_NAME,
    description: t('app.description'),
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [
      { src: icon192.src, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon512.src, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: maskable.src, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: t('pwa.shortcutOrders'), url: '/orders' },
      { name: t('pwa.shortcutWallet'), url: '/wallet' },
    ],
  };
}
