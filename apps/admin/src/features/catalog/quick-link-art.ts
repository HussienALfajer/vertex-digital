import { logoShape } from '@vertex-digital/ui';
import { themeHex } from '@vertex-digital/ui/theme-hex';

/*
 * The drawings of a direct buy link (S22 DL5): the game's cover in the middle of its QR, the QR
 * as a self-contained SVG or a PNG, and the printed card. Everything is drawn from `data:` URLs:
 * the panel's CSP allows them as images, never `blob:`, and they keep the canvas untainted.
 */

/** The QR's dark modules: green-950 on white, the darkest brand step (brand §7). */
export const QR_DARK = themeHex['green-950'];
/** The cover's square, ring included, against the QR's width: the cover is 20%. */
export const BADGE_SHARE = 0.24;
const COVER_IN_BADGE = 0.2 / BADGE_SHARE;
const BADGE_PX = 480;

function rounded(context: CanvasRenderingContext2D, x: number, y: number, side: number) {
  context.beginPath();
  context.roundRect(x, y, side, side, side * 0.18);
}

/**
 * The game's cover cropped square with rounded corners, inside a white ring, as a PNG `data:` URL
 * for the QR's `imageSettings` (the modules under it are excavated). The image route is on the
 * panel's own host, so the fetched bytes are readable and the canvas stays exportable.
 */
export async function coverBadge(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cover answered ${response.status}`);
  const cover = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_PX;
  canvas.height = BADGE_PX;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.fillStyle = 'white';
  rounded(context, 0, 0, BADGE_PX);
  context.fill();
  const side = BADGE_PX * COVER_IN_BADGE;
  const inset = (BADGE_PX - side) / 2;
  const crop = Math.min(cover.width, cover.height);
  rounded(context, inset, inset, side);
  context.clip();
  context.drawImage(
    cover,
    (cover.width - crop) / 2,
    (cover.height - crop) / 2,
    crop,
    crop,
    inset,
    inset,
    side,
    side,
  );
  cover.close();
  return canvas.toDataURL('image/png');
}

/** The QR as a standalone SVG file at `size` pixels, its cover embedded (`xlink:href` too, for older design tools). */
export function svgMarkup(svg: SVGSVGElement, size?: number): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  if (size) {
    copy.setAttribute('width', String(size));
    copy.setAttribute('height', String(size));
  }
  for (const image of copy.querySelectorAll('image')) {
    const href = image.getAttribute('href');
    if (href) image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
  }
  return new XMLSerializer().serializeToString(copy);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The QR did not render'));
    image.src = src;
  });
}

/** The QR drawn at `size` pixels from its SVG, so its modules stay sharp at print sizes. */
export async function rasterize(svg: SVGSVGElement, size: number): Promise<HTMLCanvasElement> {
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup(svg, size))}`,
  );
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.drawImage(image, 0, 0, size, size);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The PNG was not made'))),
      'image/png',
    ),
  );
}

/** A6 portrait at 300 dpi. */
export const CARD_WIDTH = 1240;
export const CARD_HEIGHT = 1748;
export const CARD_QR = 820;
const CARD_TEXT_WIDTH = 1080;
const LOGO_WIDTH = 230;

interface CardLine {
  text: string;
  size: number;
  weight: 400 | 500 | 700;
  color: string;
  rtl: boolean;
}

export interface CardContent {
  packName: string;
  gameName: string;
  callToAction: string;
  /** Already formatted (`formatUsd`), or null to leave it off. */
  price: string | null;
  link: string;
}

/**
 * The printed card: the wordmark, the pack and game names, the QR, the call to action, the price
 * when asked and the link, centred on white in the panel's fonts (brand §3), Arabic right to left.
 */
export async function drawCard(
  qr: HTMLCanvasElement,
  card: CardContent,
): Promise<HTMLCanvasElement> {
  const fonts = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim();
  const line = (
    text: string,
    size: number,
    weight: CardLine['weight'],
    color: string,
    rtl = true,
  ) => ({
    text,
    size,
    weight,
    color,
    rtl,
  });
  const top: CardLine[] = [
    line(card.packName, 80, 700, themeHex['neutral-900']),
    line(card.gameName, 48, 500, themeHex['neutral-600']),
  ];
  const bottom: CardLine[] = [
    line(card.callToAction, 64, 700, themeHex['green-800']),
    ...(card.price ? [line(card.price, 64, 700, themeHex['gold-700'], false)] : []),
    line(card.link, 30, 400, themeHex['neutral-600'], false),
  ];
  const lines = [...top, ...bottom];
  await Promise.all(
    lines.map((item) => document.fonts.load(`${item.weight} ${item.size}px ${fonts}`, item.text)),
  );

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.fillStyle = 'white';
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Long names shrink to the card's width rather than overflow it.
  const fitted = lines.map((item) => {
    let size = item.size;
    context.font = `${item.weight} ${size}px ${fonts}`;
    while (size > 20 && context.measureText(item.text).width > CARD_TEXT_WIDTH) {
      size -= 2;
      context.font = `${item.weight} ${size}px ${fonts}`;
    }
    return { ...item, size };
  });
  const height = (item: CardLine) => Math.round(item.size * 1.6);
  const [, , viewWidth = 1, viewHeight = 1] = logoShape.viewBox.split(' ').map(Number);
  const logoHeight = (LOGO_WIDTH * viewHeight) / viewWidth;
  const gap = 48;
  const stack = (items: CardLine[]) => items.reduce((sum, item) => sum + height(item), 0);
  const total =
    logoHeight + gap + stack(fitted.slice(0, 2)) + gap + CARD_QR + gap + stack(fitted.slice(2));
  let y = (CARD_HEIGHT - total) / 2;

  context.save();
  context.translate((CARD_WIDTH - LOGO_WIDTH) / 2, y);
  context.scale(LOGO_WIDTH / viewWidth, logoHeight / viewHeight);
  context.fillStyle = themeHex['green-800'];
  context.fill(new Path2D(logoShape.d), 'evenodd');
  context.restore();
  y += logoHeight + gap;

  const write = (item: CardLine) => {
    context.font = `${item.weight} ${item.size}px ${fonts}`;
    context.fillStyle = item.color;
    context.direction = item.rtl ? 'rtl' : 'ltr';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(item.text, CARD_WIDTH / 2, y + height(item) / 2);
    y += height(item);
  };
  for (const item of fitted.slice(0, 2)) write(item);
  y += gap;

  const left = (CARD_WIDTH - CARD_QR) / 2;
  context.drawImage(qr, left, y, CARD_QR, CARD_QR);
  context.strokeStyle = themeHex['neutral-200'];
  context.lineWidth = 4;
  context.beginPath();
  context.roundRect(left - 2, y - 2, CARD_QR + 4, CARD_QR + 4, 24);
  context.stroke();
  y += CARD_QR + gap;

  for (const item of fitted.slice(2)) write(item);
  return canvas;
}
