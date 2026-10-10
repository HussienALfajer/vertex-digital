import { fileURLToPath } from 'node:url';
import {
  formatUsd,
  type PublicShare,
  SHARE_IMAGE_SIZES,
  type ShareStage,
} from '@vertex-digital/contracts';
import sharp, { type OverlayOptions } from 'sharp';

/*
 * The gift and receipt images (S10 rule SH2): a fixed template drawn by sharp, the brand's dark
 * surface, the game's accent as a band, its cover, and Arabic text shaped by Pango with the
 * bundled fonts (`apps/api/assets/fonts`). It shows only what the page shows, and its
 * verification link. Every value is escaped before it reaches the markup.
 */

export type ShareImageFormat = keyof typeof SHARE_IMAGE_SIZES;

const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const FONT_FILES = [
  'noto-kufi-arabic-400.ttf',
  'noto-kufi-arabic-700.ttf',
  'montserrat-400.ttf',
  'montserrat-700.ttf',
].map((name) => `${FONTS_DIR}${name}`);
const FAMILY = 'Noto Kufi Arabic, Montserrat';

/** `brand/identity.md`: green-950 background, green-900 surface, sand accent, gold-300 text. */
const COLORS = {
  background: '#031B17',
  surface: '#0B2D28',
  sand: '#B9A87A',
  text: '#FFFFFF',
  muted: '#C8BD9E',
};

/** Rule SH4's words. */
const STAGE_TEXT: Record<ShareStage, (share: PublicShare) => string> = {
  processing: () => 'قيد الشحن',
  delivered: () => 'تم الشحن',
  partially_delivered: (share) => `تم شحن ${share.deliveredQuantity} من ${share.quantity}`,
  not_delivered: () => 'تعذّر الشحن',
};

const escapeMarkup = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A left-to-right value kept whole inside Arabic text (an embedding: Pango has no isolates). */
const ltr = (text: string) => `\u202A${text}\u202C`;

/** A name kept in its own direction: left to right when its first letter is Latin. */
const named = (text: string) => (/^[^\p{L}]*\p{Script=Latin}/u.test(text) ? ltr(text) : text);

let fontsLoaded: Promise<void> | null = null;

/** libvips adds each font file to fontconfig once per process: draw a character with each. */
function loadFonts(): Promise<void> {
  fontsLoaded ??= (async () => {
    for (const fontfile of FONT_FILES) {
      await sharp({ text: { text: '.', fontfile, font: FAMILY } })
        .png()
        .toBuffer();
    }
  })();
  return fontsLoaded;
}

/** One block of right-aligned Arabic text as a transparent PNG at most `width` wide. */
async function textBlock(markup: string, size: number, width: number, weight: 400 | 700 = 400) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${COLORS.text}">${markup}</span>`,
      font: `${FAMILY} ${weight === 700 ? 'Bold ' : ''}${size}`,
      width,
      align: 'left',
      wrap: 'word-char',
      spacing: Math.round(size * 0.4),
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The lines of the card: what the page shows, in the same order. */
function lines(share: PublicShare, verifyUrl: string) {
  const muted = (text: string) => `<span foreground="${COLORS.muted}">${text}</span>`;
  const pack = `${named(escapeMarkup(share.product.nameAr))}${share.quantity > 1 ? ` × ${share.quantity}` : ''}`;
  const body = [
    `${named(escapeMarkup(share.game.nameAr))} · ${pack}`,
    ...share.fields.map(
      (field) => `${muted(escapeMarkup(field.label))}: ${ltr(escapeMarkup(field.value))}`,
    ),
    `<b>${STAGE_TEXT[share.stage](share)}</b>`,
  ];
  if (share.kind === 'gift') {
    if (share.gift?.senderName) body.unshift(`من ${escapeMarkup(share.gift.senderName)}`);
    if (share.gift?.message) body.push(`«${escapeMarkup(share.gift.message)}»`);
  }
  if (share.price) {
    body.push(`المدفوع: ${ltr(formatUsd(share.price.totalUsdUnits))}`);
    if (share.price.refundedUsdUnits > 0) {
      body.push(`المُسترد: ${ltr(formatUsd(share.price.refundedUsdUnits))}`);
    }
  }
  return {
    title:
      share.kind === 'gift' ? 'هدية لك' : `إيصال طلب ${ltr(escapeMarkup(share.orderNumber ?? ''))}`,
    body: body.join('\n'),
    footer: muted(`تحقق من هذا الإيصال على ${ltr(escapeMarkup(verifyUrl))}`),
  };
}

/**
 * Renders the share as a PNG of the format's fixed size. `cover` is the game's stored image (any
 * format sharp reads), or null: the accent band alone (edge case 25).
 */
export async function renderShareImage(
  share: PublicShare,
  format: ShareImageFormat,
  cover: Buffer | null,
  verifyUrl: string,
): Promise<Buffer> {
  await loadFonts();
  const { width, height } = SHARE_IMAGE_SIZES[format];
  const accent = share.game.accentColor ?? COLORS.sand;
  const margin = Math.round(width * 0.06);
  const coverSize = format === 'og' ? 200 : 260;
  const band = 16;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${COLORS.background}"/>
      <rect x="${margin / 2}" y="${margin / 2}" width="${width - margin}" height="${height - margin}" fill="${COLORS.surface}"/>
      <rect x="${margin / 2}" y="${margin / 2}" width="${width - margin}" height="${band}" fill="${accent}"/>
    </svg>`,
  );
  const text = lines(share, verifyUrl);
  const textWidth = width - margin * 2 - (cover ? coverSize + margin / 2 : 0);
  const top = margin / 2 + band + margin / 2;
  const [title, body, footer, brand] = await Promise.all([
    textBlock(text.title, format === 'og' ? 44 : 60, textWidth, 700),
    textBlock(text.body, format === 'og' ? 26 : 38, textWidth),
    textBlock(text.footer, format === 'og' ? 18 : 22, width - margin * 2),
    textBlock(`<span foreground="${COLORS.sand}">VERTEX DIGITAL</span>`, 24, 400, 700),
  ]);
  const layers: OverlayOptions[] = [
    { input: title.data, top, left: width - margin - title.width },
    {
      input: body.data,
      top: top + title.height + Math.round(margin / 3),
      left: width - margin - body.width,
    },
    {
      input: footer.data,
      top: height - margin - footer.height,
      left: width - margin - footer.width,
    },
    { input: brand.data, top: height - margin - footer.height - brand.height - 12, left: margin },
  ];
  if (cover) {
    layers.unshift({
      input: await sharp(cover).resize(coverSize, coverSize, { fit: 'cover' }).png().toBuffer(),
      top,
      left: margin,
    });
  }
  return sharp(background).composite(layers).png().toBuffer();
}
