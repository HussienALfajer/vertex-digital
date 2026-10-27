import {
  formatSyp,
  formatUsd,
  type MerchantPriceList,
  type MerchantPriceListRow,
  REVIEW_TIME_ZONE,
} from '@vertex-digital/contracts';
import sharp, { type OverlayOptions } from 'sharp';
import { escapeMarkup, loadFonts, ltr, named, textBlock } from '../../core/images/pango-text.js';

/*
 * The price list image for WhatsApp (S21 PL2, PL3): 1080 px wide, the brand's dark surface, the
 * shop's name and logo, "قائمة الأسعار" with the Damascus date and time and "الأسعار قابلة
 * للتغيير", then each game's packs with their prices, at most 60 packs per image. Drawn by sharp
 * with Pango like the share image; every value is escaped; the whole render (text blocks, logo and
 * composite) stops after 10 seconds (audit A06-38).
 */

/** PL3: the time one image may take to render, every step included. */
export const PRICE_LIST_RENDER_BUDGET_MS = 10_000;

/** A render that passed its budget: an unhandled error, never a partial image. */
class RenderTimeout extends Error {}

const WIDTH = 1080;
const MARGIN = 60;
const LOGO_SIZE = 140;
const ROW_GAP = 18;
const PRICE_WIDTH = 360;

/** `brand/identity.md`: green-950 background, green-900 surface, sand accent. */
const COLORS = {
  background: '#031B17',
  surface: '#0B2D28',
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

/** PL1: the price in the chosen currency; USD when there is no rate for SYP. */
function priceText(row: MerchantPriceListRow, currency: MerchantPriceList['currency']): string {
  if (!row.available || row.usdUnits === null) return 'غير متوفر';
  const dollars = ltr(formatUsd(row.usdUnits));
  if (row.sypUnits === null || currency === 'usd') return dollars;
  const pounds = `${ltr(formatSyp(row.sypUnits))} ل.س`;
  return currency === 'both' ? `${pounds} · ${dollars}` : pounds;
}

type ListOfImage = Pick<MerchantPriceList, 'tradeName' | 'generatedAt' | 'currency' | 'games'>;

/**
 * Renders one image of the list: `list.games` holds this page's packs only. `logo` is the stored
 * logo (any format sharp reads), or null. Refused once `budgetMs` has passed, whichever step is
 * running; no step starts after it.
 */
export async function renderPriceListImage(
  list: ListOfImage,
  pages: { page: number; pages: number },
  logo: Buffer | null,
  budgetMs = PRICE_LIST_RENDER_BUDGET_MS,
): Promise<Buffer> {
  const deadline = Date.now() + budgetMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      draw(list, pages, logo, deadline),
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
  const headerWidth = inner - (logo ? LOGO_SIZE + 24 : 0);
  const header = await Promise.all([
    textBlock(named(escapeMarkup(list.tradeName)), 46, headerWidth, { ...text, weight: 700 }),
    textBlock(`قائمة الأسعار · ${ltr(damascusTime(list.generatedAt))}`, 30, headerWidth, {
      color: COLORS.sand,
      weight: 700,
    }),
    textBlock('الأسعار قابلة للتغيير', 24, headerWidth, muted),
  ]);
  const blocks: {
    kind: 'game' | 'row';
    name: Awaited<ReturnType<typeof textBlock>>;
    price?: Awaited<ReturnType<typeof textBlock>>;
  }[] = [];
  for (const game of list.games) {
    step();
    blocks.push({
      kind: 'game',
      name: await textBlock(named(escapeMarkup(game.nameAr)), 34, inner, {
        color: COLORS.sand,
        weight: 700,
      }),
    });
    const rows = await Promise.all(
      game.rows.map(async (row) => ({
        kind: 'row' as const,
        name: await textBlock(named(escapeMarkup(row.nameAr)), 28, inner - PRICE_WIDTH - 24, text),
        price: await textBlock(priceText(row, list.currency), 28, PRICE_WIDTH, {
          ...(row.available ? text : muted),
          weight: 700,
        }),
      })),
    );
    blocks.push(...rows);
  }
  step();
  const footer =
    pages.pages > 1
      ? await textBlock(`${ltr(`${pages.page} / ${pages.pages}`)}`, 22, inner, muted)
      : null;

  const layers: OverlayOptions[] = [];
  const lines: string[] = [];
  let top = MARGIN;
  const headerTop = top;
  for (const block of header) {
    layers.push({ input: block.data, top, left: WIDTH - MARGIN - block.width });
    top += block.height + 10;
  }
  if (logo) {
    step();
    layers.push({
      input: await sharp(logo)
        .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: COLORS.surface })
        .png()
        .toBuffer(),
      top: headerTop,
      left: MARGIN,
    });
    top = Math.max(top, headerTop + LOGO_SIZE + 10);
  }
  top += 20;
  for (const block of blocks) {
    if (block.kind === 'game') top += 16;
    const height = Math.max(block.name.height, block.price?.height ?? 0);
    layers.push({ input: block.name.data, top, left: WIDTH - MARGIN - block.name.width });
    if (block.price) layers.push({ input: block.price.data, top, left: MARGIN });
    top += height + ROW_GAP;
    if (block.kind === 'row') {
      lines.push(
        `<rect x="${MARGIN}" y="${top - ROW_GAP / 2}" width="${inner}" height="1" fill="${COLORS.line}"/>`,
      );
    }
  }
  if (footer) {
    top += 10;
    layers.push({ input: footer.data, top, left: MARGIN });
    top += footer.height;
  }
  const height = top + MARGIN;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">
      <rect width="100%" height="100%" fill="${COLORS.background}"/>
      <rect x="${MARGIN / 2}" y="${MARGIN / 2}" width="${WIDTH - MARGIN}" height="${height - MARGIN}" fill="${COLORS.surface}"/>
      ${lines.join('')}
    </svg>`,
  );
  step();
  // libvips stops the composite itself at the time left, whole seconds, one at least.
  const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  return sharp(background).composite(layers).png().timeout({ seconds }).toBuffer();
}
