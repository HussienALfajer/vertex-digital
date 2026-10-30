import type { MerchantTier } from '@vertex-digital/contracts';
import { themeHex } from '@vertex-digital/ui/theme-hex';

/*
 * The shop sticker (S23 ID8), drawn in the browser on a canvas, never by the server: the tier's
 * mark, the trade name, "تاجر ذهبي معتمد من Vertex Digital" (Bronze without the tier), the
 * certificate's QR and the store's domain, on the brand's deep green. A square 1080 px for posts
 * and a story 1080 × 1920 px. Everything is drawn from `data:` URLs, so the canvas stays
 * exportable (the store's CSP allows them as images, never `blob:`).
 */

export type StickerShape = 'square' | 'story';

const SIZES = { square: [1080, 1080], story: [1080, 1920] } as const;

/** The tier's mark on the dark sticker: the `400` steps of `brand/identity.md` §2. */
const TIER_MARKS = {
  bronze: themeHex['tier-bronze-400'],
  silver: themeHex['tier-silver-400'],
  gold: themeHex['gold-400'],
  diamond: themeHex['tier-diamond-400'],
} as const satisfies Record<MerchantTier, string>;

/** The Lucide icons of the tiers (ISC licence), as path data on a 24 px grid. */
const TIER_PATHS: Record<MerchantTier, string[]> = {
  bronze: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  ],
  silver: [
    'M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15',
    'M11 12 5.12 2.2',
    'm13 12 5.88-9.8',
    'M8 7h8',
    'M17 17a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    'M12 18v-2h-.5',
  ],
  gold: [
    'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z',
    'M5 21h14',
  ],
  diamond: ['M6 3h12l4 6-10 13L2 9Z', 'M11 3 8 9l4 13 4-13-3-6', 'M2 9h20'],
};

export interface StickerContent {
  tier: MerchantTier;
  tradeName: string;
  /** `approvedLine(tier)`: the line under the trade name. */
  approved: string;
  /** The store's host, `digital.vertexmedia.pro`. */
  domain: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The QR did not render'));
    image.src = src;
  });
}

/** The certificate's QR (`QRCodeSVG` in the page) drawn at `size` pixels from its SVG. */
async function qrImage(svg: SVGSVGElement, size: number): Promise<HTMLImageElement> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('width', String(size));
  copy.setAttribute('height', String(size));
  const markup = new XMLSerializer().serializeToString(copy);
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
}

/** ID8: the sticker as a PNG blob. */
export async function drawSticker(
  shape: StickerShape,
  content: StickerContent,
  qr: SVGSVGElement,
): Promise<Blob> {
  const [width, height] = SIZES[shape];
  const fonts = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim();
  const mark = TIER_MARKS[content.tier];
  const lines = [
    { text: content.tradeName, size: 84, weight: 700, color: themeHex['neutral-100'] },
    { text: content.approved, size: 44, weight: 700, color: mark },
  ];
  await Promise.all(
    lines.map((line) => document.fonts.load(`${line.weight} ${line.size}px ${fonts}`, line.text)),
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.fillStyle = themeHex['green-950'];
  context.fillRect(0, 0, width, height);
  // A frame in the tier's mark, 4% inside the edge.
  const inset = Math.round(width * 0.04);
  context.strokeStyle = mark;
  context.lineWidth = 6;
  context.strokeRect(inset, inset, width - inset * 2, height - inset * 2);

  const qrSize = shape === 'square' ? 360 : 560;
  const icon = shape === 'square' ? 120 : 180;
  const gap = shape === 'square' ? 28 : 56;
  const textHeight = (size: number) => Math.round(size * 1.5);
  const total = icon + gap + textHeight(84) + textHeight(44) + gap + qrSize + gap + textHeight(32);
  let y = (height - total) / 2;

  // The tier's icon, stroked as Lucide draws it.
  context.save();
  context.translate((width - icon) / 2, y);
  context.scale(icon / 24, icon / 24);
  context.strokeStyle = mark;
  context.lineWidth = 2;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const path of TIER_PATHS[content.tier]) context.stroke(new Path2D(path));
  context.restore();
  y += icon + gap;

  const write = (text: string, size: number, weight: number, color: string, rtl = true) => {
    let fitted = size;
    context.font = `${weight} ${fitted}px ${fonts}`;
    while (fitted > 24 && context.measureText(text).width > width - inset * 4) {
      fitted -= 2;
      context.font = `${weight} ${fitted}px ${fonts}`;
    }
    context.fillStyle = color;
    context.direction = rtl ? 'rtl' : 'ltr';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, width / 2, y + textHeight(size) / 2);
    y += textHeight(size);
  };
  for (const line of lines) write(line.text, line.size, line.weight, line.color);
  y += gap;

  // The QR on white with its quiet zone, so any phone reads it.
  const left = (width - qrSize) / 2;
  context.fillStyle = 'white';
  context.beginPath();
  context.roundRect(left - 16, y - 16, qrSize + 32, qrSize + 32, 24);
  context.fill();
  context.drawImage(await qrImage(qr, qrSize), left, y, qrSize, qrSize);
  y += qrSize + gap;

  // The store's domain, in sand.
  write(content.domain, 32, 500, themeHex['gold-400'], false);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The PNG was not made'))),
      'image/png',
    ),
  );
}
