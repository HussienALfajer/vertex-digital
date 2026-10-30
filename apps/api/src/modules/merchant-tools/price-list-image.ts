import {
  formatSyp,
  formatUsd,
  type MerchantPriceList,
  type MerchantPriceListRow,
  REVIEW_TIME_ZONE,
} from '@vertex-digital/contracts';
import sharp, { type OverlayOptions } from 'sharp';
import { escapeMarkup, loadFonts, ltr, named, textBlock } from '../../core/images/pango-text.js';
import { TIER_COLORS, tierIconSvg, tierLine } from './tier-mark.js';

/*
 * The price list image for WhatsApp (S21 PL2, PL3; owner, 2026-10-30, as the printed list): 1080 px
 * wide, the brand's dark surface, the shop's name and logo with its tier's line, "قائمة الأسعار"
 * with the Damascus date and time, then each game under its cover and name with its packs in
 * alternating rows (USD before SYP when both show), and a footer with the date, "الأسعار قابلة
 * للتغيير" and the shop's WhatsApp when its receipts show it; at most 60 packs per image. Drawn by
 * sharp with Pango like the share image, Arabic shaped by Pango; every value is escaped; the whole
 * render (text blocks, images and composite) stops after 10 seconds (audit A06-38).
 */

/** PL3: the time one image may take to render, every step included. */
export const PRICE_LIST_RENDER_BUDGET_MS = 10_000;

/** A render that passed its budget: an unhandled error, never a partial image. */
class RenderTimeout extends Error {}

const WIDTH = 1080;
const MARGIN = 60;
const LOGO_SIZE = 140;
/** S23 ID6: the tier's icon before its line. */
const TIER_ICON_SIZE = 30;
/** A game's cover beside its name. */
const COVER_SIZE = 64;
const ROW_PADDING = 12;
const PRICE_WIDTH = 400;

/** `brand/identity.md`: green-950 background, green-900 surface, sand accent. */
const COLORS = {
  background: '#031B17',
  surface: '#0B2D28',
  /** Every other row, a step lighter than the surface. */
  stripe: '#123A34',
  line: '#174A42',
  sand: '#B9A87A',
  text: '#FFFFFF',
  muted: '#C8BD9E',
};

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: REVIEW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `2026/10/21 14:05`, Damascus time. */
function damascusTime(iso: string): string {
  const parts = Object.fromEntries(
    dateTime.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** PL1: the price in the chosen currency, USD first when both show; USD alone without a rate. */
export function priceText(
  row: MerchantPriceListRow,
  currency: MerchantPriceList['currency'],
): string {
  if (!row.available || row.usdUnits === null) return 'غير متوفر';
  const dollars = ltr(formatUsd(row.usdUnits));
  if (row.sypUnits === null || currency === 'usd') return dollars;
  const pounds = `${ltr(formatSyp(row.sypUnits))} ل.س`;
  // A right-to-left mark first: Pango reads a line that opens with an embedding as left to right,
  // which puts the pounds before the dollars and "ل.س" on the number's other side.
  return `‏${currency === 'both' ? `${dollars} ‏·‏ ${pounds}` : pounds}`;
}

type ListOfImage = Pick<
  MerchantPriceList,
  'tradeName' | 'generatedAt' | 'currency' | 'games' | 'tier' | 'largeLogo' | 'whatsapp'
>;

/**
 * Renders one image of the list: `list.games` holds this page's packs only. `logo` is the stored
 * logo and `covers` the games' covers by game id (any format sharp reads); a game without one
 * shows its name alone. Refused once `budgetMs` has passed, whichever step is running; no step
 * starts after it.
 */
export async function renderPriceListImage(
  list: ListOfImage,
  pages: { page: number; pages: number },
  logo: Buffer | null,
  covers: ReadonlyMap<string, Buffer> = new Map(),
  budgetMs = PRICE_LIST_RENDER_BUDGET_MS,
): Promise<Buffer> {
  const deadline = Date.now() + budgetMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      draw(list, pages, logo, covers, deadline),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timedOut(budgetMs)), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const timedOut = (budgetMs: number) =>
  new RenderTimeout(`The price list image took longer than ${budgetMs} ms`);

async function draw(
  list: ListOfImage,
  pages: { page: number; pages: number },
  logo: Buffer | null,
  covers: ReadonlyMap<string, Buffer>,
  deadline: number,
): Promise<Buffer> {
  /** Before each step: a render past its deadline starts nothing more. */
  const step = () => {
    if (Date.now() >= deadline) throw new RenderTimeout('The price list image passed its budget');
  };
  await loadFonts();
  step();
  const inner = WIDTH - MARGIN * 2;
  const text = { color: COLORS.text };
  const muted = { color: COLORS.muted };
  // S23 RC2: a tier with `receipt_large_logo` prints the logo at twice the size.
  const logoSize = list.largeLogo ? LOGO_SIZE * 2 : LOGO_SIZE;
  const headerWidth = inner - (logo ? logoSize + 24 : 0);
  const header = await Promise.all([
    textBlock(named(escapeMarkup(list.tradeName)), 46, headerWidth, { ...text, weight: 700 }),
    // S23 ID6: the tier's line in its colour, its icon drawn beside it.
    textBlock(tierLine(list.tier), 26, headerWidth - TIER_ICON_SIZE - 12, {
      color: TIER_COLORS[list.tier],
      weight: 700,
    }),
    textBlock(`قائمة الأسعار · ${ltr(damascusTime(list.generatedAt))}`, 30, headerWidth, {
      color: COLORS.sand,
      weight: 700,
    }),
  ]);
  type Block = Awaited<ReturnType<typeof textBlock>>;
  const sections: {
    title: Block;
    cover: Buffer | null;
    rows: { name: Block; price: Block }[];
  }[] = [];
  for (const game of list.games) {
    step();
    const stored = covers.get(game.gameId);
    const cover = stored
      ? await sharp(stored)
          .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover' })
          .composite([
            {
              input: Buffer.from(
                `<svg width="${COVER_SIZE}" height="${COVER_SIZE}"><rect width="${COVER_SIZE}" height="${COVER_SIZE}" rx="10" ry="10"/></svg>`,
              ),
              blend: 'dest-in',
            },
          ])
          .png()
          .toBuffer()
      : null;
    const titleWidth = inner - (cover ? COVER_SIZE + 16 : 0);
    sections.push({
      title: await textBlock(named(escapeMarkup(game.nameAr)), 34, titleWidth, {
        color: COLORS.sand,
        weight: 700,
      }),
      cover,
      rows: await Promise.all(
        game.rows.map(async (row) => ({
          name: await textBlock(
            named(escapeMarkup(row.nameAr)),
            28,
            inner - PRICE_WIDTH - ROW_PADDING * 3,
            text,
          ),
          price: await textBlock(priceText(row, list.currency), 28, PRICE_WIDTH, {
            ...(row.available ? text : muted),
            weight: 700,
          }),
        })),
      ),
    });
  }
  step();
  const footerLine = [
    'الأسعار قابلة للتغيير',
    ...(list.whatsapp ? [`واتساب ${ltr(escapeMarkup(list.whatsapp))}`] : []),
    ...(pages.pages > 1 ? [ltr(`${pages.page} / ${pages.pages}`)] : []),
    // A right-to-left mark on each side of the dot: two numbers in a row never merge into one run.
  ].join('\u200F · \u200F');
  const footer = await textBlock(footerLine, 22, inner, muted);

  const layers: OverlayOptions[] = [];
  const shapes: string[] = [];
  let top = MARGIN;
  const headerTop = top;
  for (const [index, block] of header.entries()) {
    const right = index === 1 ? TIER_ICON_SIZE + 12 : 0;
    layers.push({ input: block.data, top, left: WIDTH - MARGIN - right - block.width });
    if (index === 1) {
      layers.push({
        input: tierIconSvg(list.tier, TIER_ICON_SIZE),
        top: top + Math.max(0, Math.round((block.height - TIER_ICON_SIZE) / 2)),
        left: WIDTH - MARGIN - TIER_ICON_SIZE,
      });
    }
    top += block.height + 10;
  }
  if (logo) {
    step();
    layers.push({
      input: await sharp(logo)
        .resize(logoSize, logoSize, { fit: 'contain', background: COLORS.surface })
        .png()
        .toBuffer(),
      top: headerTop,
      left: MARGIN,
    });
    top = Math.max(top, headerTop + logoSize + 10);
  }
  top += 10;
  shapes.push(`<rect x="${MARGIN}" y="${top}" width="${inner}" height="2" fill="${COLORS.sand}"/>`);
  top += 24;
  for (const section of sections) {
    const titleHeight = Math.max(section.title.height, section.cover ? COVER_SIZE : 0);
    if (section.cover) {
      layers.push({ input: section.cover, top, left: WIDTH - MARGIN - COVER_SIZE });
    }
    layers.push({
      input: section.title.data,
      top: top + Math.round((titleHeight - section.title.height) / 2),
      left: WIDTH - MARGIN - (section.cover ? COVER_SIZE + 16 : 0) - section.title.width,
    });
    top += titleHeight + 12;
    for (const [index, row] of section.rows.entries()) {
      const height = Math.max(row.name.height, row.price.height) + ROW_PADDING * 2;
      shapes.push(
        `<rect x="${MARGIN}" y="${top}" width="${inner}" height="${height}" rx="6" ry="6" fill="${index % 2 === 0 ? COLORS.stripe : COLORS.surface}"/>`,
      );
      layers.push({
        input: row.name.data,
        top: top + ROW_PADDING,
        left: WIDTH - MARGIN - ROW_PADDING - row.name.width,
      });
      layers.push({ input: row.price.data, top: top + ROW_PADDING, left: MARGIN + ROW_PADDING });
      top += height;
    }
    top += 28;
  }
  shapes.push(`<rect x="${MARGIN}" y="${top}" width="${inner}" height="1" fill="${COLORS.line}"/>`);
  top += 16;
  layers.push({ input: footer.data, top, left: WIDTH - MARGIN - footer.width });
  top += footer.height;
  const height = top + MARGIN;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">
      <rect width="100%" height="100%" fill="${COLORS.background}"/>
      <rect x="${MARGIN / 2}" y="${MARGIN / 2}" width="${WIDTH - MARGIN}" height="${height - MARGIN}" fill="${COLORS.surface}"/>
      ${shapes.join('')}
    </svg>`,
  );
  step();
  // libvips stops the composite itself at the time left, whole seconds, one at least.
  const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  return sharp(background).composite(layers).png().timeout({ seconds }).toBuffer();
}
