import { logoShape } from '@vertex-digital/ui/brand/logo-shapes';
import { themeHex } from '@vertex-digital/ui/theme-hex';
import { t } from '@/lib/i18n';

/**
 * SW5: the offline page as one self-contained document (inline styles, the inline logo, the
 * system Arabic fonts, no file to fetch), dark (brand/identity.md §2: green-950 background, neutral text, sand
 * logo, sand action). Its only script is the constant `onclick` that reloads. The text is ours,
 * from the catalog; nothing in it comes from a request.
 */
export function offlinePage(): string {
  const {
    'green-950': background,
    'gold-400': sand,
    'neutral-100': text,
    'neutral-300': muted,
  } = themeHex;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${background}">
<title>${t('pwa.offline.title')}</title>
<style>
html,body{margin:0;height:100%;background:${background};color:${text}}
body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,"Geeza Pro","Noto Sans Arabic",sans-serif;text-align:center}
main{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:28rem}
svg{width:96px;height:auto;color:${sand}}
h1{margin:8px 0 0;font-size:1.375rem}
p{margin:0;line-height:1.7;color:${muted}}
button{margin-top:8px;min-height:44px;padding:0 24px;border:0;border-radius:8px;background:${sand};color:${background};font:inherit;font-weight:700;cursor:pointer}
button:focus-visible{outline:2px solid ${text};outline-offset:2px}
</style>
</head>
<body>
<main>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${logoShape.viewBox}" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${logoShape.d}"/></svg>
<h1>${t('pwa.offline.title')}</h1>
<p>${t('pwa.offline.body')}</p>
<button type="button" onclick="location.reload()">${t('pwa.offline.retry')}</button>
</main>
</body>
</html>
`;
}
