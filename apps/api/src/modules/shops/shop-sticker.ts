import type { ShopStickerSize } from '@vertex-digital/contracts';
import QRCode from 'qrcode';
import sharp, { type OverlayOptions } from 'sharp';
import { escapeMarkup, loadFonts, ltr, named, textBlock } from '../../core/images/pango-text.js';

/*
 * The shop's printable sticker (S26 SP2): the logo (or the name's letter on the brand color), the
 * shop's approved name, "اشحن ألعابك من متجرنا" and a QR to the shop's link, on white so any
 * printer prints it. A6 at 300 dpi, or an 80 mm receipt roll at 203 dpi. Every value is escaped
 * before it reaches the markup.
 */

const SIZES: Record<ShopStickerSize, { width: number; height: number }> = {
  a6: { width: 1240, height: 1748 },
  '80mm': { width: 640, height: 940 },
};

const INK = '#0B2D28';

export interface ShopSticker {
  name: string;
  brandColor: string;
  /** `https://digital.vertexmedia.pro/s/<slug>`. */
  url: string;
  /** The merchant's receipt logo (any format sharp reads), or null for the letter mark. */
  logo: Buffer | null;
  size: ShopStickerSize;
}

export async function renderShopSticker(sticker: ShopSticker): Promise<Buffer> {
  await loadFonts();
  const { width, height } = SIZES[sticker.size];
  const margin = Math.round(width * 0.07);
  const band = Math.round(height * 0.03);
  const mark = Math.round(width * 0.28);
  const qrSize = Math.round(width * 0.62);
  const scale = width / 1240;

  const qr = await sharp(
    Buffer.from(
      await QRCode.toString(sticker.url, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' },
      }),
    ),
  )
    .resize(qrSize, qrSize)
    .png()
    .toBuffer();
  const logo = sticker.logo
    ? await sharp(sticker.logo)
        .resize(mark, mark, { fit: 'contain', background: '#FFFFFF' })
        .png()
        .toBuffer()
    : await letterMark(sticker.name, sticker.brandColor, mark);
  const [name, call, link] = await Promise.all([
    textBlock(named(escapeMarkup(sticker.name)), Math.round(76 * scale), width - margin * 2, {
      color: INK,
      weight: 700,
    }),
    textBlock('اشحن ألعابك من متجرنا', Math.round(56 * scale), width - margin * 2, {
      color: INK,
    }),
    textBlock(
      ltr(escapeMarkup(sticker.url.replace(/^https?:\/\//, ''))),
      Math.round(34 * scale),
      width - margin * 2,
      { color: INK },
    ),
  ]);

  const center = (blockWidth: number) => Math.max(0, Math.round((width - blockWidth) / 2));
  let top = band + margin;
  const layers: OverlayOptions[] = [{ input: logo, top, left: center(mark) }];
  top += mark + Math.round(margin / 2);
  layers.push({ input: name.data, top, left: center(name.width) });
  top += name.height + Math.round(margin / 3);
  layers.push({ input: call.data, top, left: center(call.width) });
  top += call.height + Math.round(margin / 2);
  layers.push({ input: qr, top, left: center(qrSize) });
  top += qrSize + Math.round(margin / 3);
  layers.push({ input: link.data, top, left: center(link.width) });

  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <rect width="100%" height="${band}" fill="${sticker.brandColor}"/>
      <rect y="${height - band}" width="100%" height="${band}" fill="${sticker.brandColor}"/>
    </svg>`,
  );
  return sharp(background).composite(layers).png().toBuffer();
}

/** ST2: the name's first letter in white on the brand color, as a square. */
async function letterMark(name: string, color: string, size: number): Promise<Buffer> {
  const letter = await textBlock(escapeMarkup([...name.trim()][0] ?? '؟'), size * 0.5, size, {
    color: '#FFFFFF',
    weight: 700,
  });
  return sharp({ create: { width: size, height: size, channels: 4, background: color } })
    .composite([{ input: letter.data, gravity: 'center' }])
    .png()
    .toBuffer();
}
