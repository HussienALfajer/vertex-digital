import { Inject, Injectable } from '@nestjs/common';
import {
  isBotUserAgent,
  SHOP_ICON_SIZES,
  type ShopGame,
  type ShopManifest,
  type ShopProduct,
  type ShopPublic,
  type ShopStorefront,
  shopPackSellable,
  shopSellingPrice,
  shopSellingSyp,
  zoneDate,
} from '@vertex-digital/contracts';
import {
  accountPriceList,
  type Database,
  merchantEarlyAccess,
  merchantShopHiddenGames,
  merchantShopSlugs,
  merchantShops,
  ownSellingPrices,
  pinnedGameIds,
  rateInForce,
  readAll,
  receiptSettingsOf,
  sellingSettingsOf,
  shopDailyStats,
  shopRateNow,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { escapeMarkup, loadFonts, textBlock } from '../../core/images/pango-text.js';
import { CatalogStoreService } from '../catalog/index.js';
import { FilesService, type ServedFile } from '../files/index.js';

type ShopRow = typeof merchantShops.$inferSelect;

/** S26 Access: the shop's public pages answer while it is active, suspended or closed. */
const OPEN = ['active', 'suspended', 'closed'] as const;

const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such shop');

/** SH3: an old slug answers `301` with the shop's current slug. */
export class ShopMoved extends Error {
  constructor(readonly slug: string) {
    super(`The shop moved to ${slug}`);
  }
}

/**
 * The shop's public pages (S26 PR1–PR4, SP1, SP3, SP4): the home and a game at the merchant's
 * selling prices, the logo, the icons and the manifest data, and the visit counter. Never the
 * merchant's purchase price, the margin, the list's name or Vertex's retail price: a pack carries
 * its selling price only, so the store may cache the answers (tag `shop:<id>`).
 */
@Injectable()
export class ShopStorefrontService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly catalog: CatalogStoreService,
    private readonly files: FilesService,
  ) {}

  /** The open shop holding `slug` now; an old slug throws `ShopMoved` (SH3). */
  async shopOf(slug: string): Promise<ShopRow> {
    const wanted = slug.toLowerCase();
    const [current] = await this.db
      .select()
      .from(merchantShops)
      .where(and(eq(merchantShops.slug, wanted), inArray(merchantShops.status, [...OPEN])));
    if (current) return current;
    const [held] = await this.db
      .select({ shop: merchantShops })
      .from(merchantShopSlugs)
      .innerJoin(merchantShops, eq(merchantShops.id, merchantShopSlugs.shopId))
      .where(eq(merchantShopSlugs.slug, wanted));
    if (held && held.shop.slug !== wanted && OPEN.some((s) => s === held.shop.status)) {
      throw new ShopMoved(held.shop.slug);
    }
    throw notFound();
  }

  /** `GET /api/shops/:slug` (PR1): pinned games first, then the categories. */
  async storefront(slug: string): Promise<ShopStorefront> {
    const shop = await this.shopOf(slug);
    const [publicShop, hidden, earlyAccess, pinned] = await readAll(this.db, [
      () => this.publicShop(shop),
      () => this.hiddenGames(shop.id),
      () => this.earlyAccess(shop),
      () => pinnedGameIds(this.db, shop.merchantId),
    ]);
    const front = await this.catalog.shopStorefront({ hiddenGameIds: hidden, earlyAccess });
    const games = new Map(
      front.categories.flatMap((category) => category.games.map((game) => [game.id, game])),
    );
    return {
      shop: publicShop,
      service: front.service,
      pinned: pinned.flatMap((id) => games.get(id) ?? []),
      categories: front.categories,
    };
  }

  /** `GET /api/shops/:slug/games/:game` (PR1–PR4): packs at the selling price, never the cost. */
  async game(slug: string, gameSlug: string): Promise<ShopGame> {
    const shop = await this.shopOf(slug);
    const [publicShop, hidden, earlyAccess, priceListId] = await readAll(this.db, [
      () => this.publicShop(shop),
      () => this.hiddenGames(shop.id),
      () => this.earlyAccess(shop),
      () => this.priceListOf(shop),
    ]);
    const store = await this.catalog.shopGame(gameSlug, {
      hiddenGameIds: hidden,
      earlyAccess,
      priceListId,
    });
    const [settings, own, storeRate] = await readAll(this.db, [
      () => sellingSettingsOf(this.db, shop.merchantId),
      () =>
        ownSellingPrices(
          this.db,
          shop.merchantId,
          store.products.map((product) => product.id),
        ),
      () => rateInForce(this.db),
    ]);
    const step = settings.sypStepUnits ?? storeRate?.displayStepSypUnits ?? null;
    const products = store.products.map((product): ShopProduct => {
      const buy = product.available ? product.priceUsdUnits : null;
      const ownPrice = own.get(product.id) ?? null;
      const sell = buy === null ? null : shopSellingPrice(buy, settings, ownPrice, publicShop.rate);
      const sold = buy !== null && shopPackSellable(sell, buy);
      return {
        id: product.id,
        kind: product.kind,
        nameAr: product.nameAr,
        gameAmount: product.gameAmount,
        maxQuantity: product.maxQuantity,
        minQuantity: product.minQuantity,
        amountUnitAr: product.amountUnitAr,
        amountStep: product.amountStep,
        deliveryStats: product.deliveryStats,
        playerCheck: product.playerCheck,
        regionAr: product.regionAr,
        redemptionAr: product.redemptionAr,
        available: sold,
        unitSellUsdUnits: sold ? sell : null,
        unitSellSypUnits:
          sold && sell !== null && step !== null
            ? shopSellingSyp(sell, ownPrice, publicShop.rate, step)
            : null,
      };
    });
    return {
      shop: publicShop,
      game: {
        id: store.game.id,
        slug: store.game.slug,
        nameAr: store.game.nameAr,
        nameEn: store.game.nameEn,
        cover: store.game.cover,
        accentColor: store.game.accentColor,
        status: store.game.status,
        idGuide: store.game.idGuide,
        regionNotesAr: store.game.regionNotesAr,
        serviceClass: store.game.serviceClass,
      },
      fields: store.fields,
      products,
    };
  }

  /** SP1: what the store's web manifest is built from. */
  async manifest(slug: string): Promise<ShopManifest> {
    const shop = await this.shopOf(slug);
    const brand = await receiptSettingsOf(this.db, shop.merchantId);
    const version = brand?.logoFileId ?? shop.brandColor.slice(1);
    return {
      name: shop.displayName,
      shortName: [...shop.displayName].slice(0, 12).join(''),
      brandColor: shop.brandColor,
      slug: shop.slug,
      icons: SHOP_ICON_SIZES.map((size) => ({
        size,
        url: `/api/shops/${shop.slug}/icon?size=${size}&v=${version}`,
      })),
    };
  }

  /** ST2: the merchant's receipt logo, in color; not found without one. */
  async logo(slug: string): Promise<ServedFile> {
    const shop = await this.shopOf(slug);
    const brand = await receiptSettingsOf(this.db, shop.merchantId);
    const file = brand?.logoFileId
      ? await this.files.serve(brand.logoFileId, 'merchant_logo')
      : null;
    if (!file) throw new CodedException(404, 'NOT_FOUND', 'No logo');
    return file;
  }

  /**
   * SP1: a square PNG icon: the logo on white with a margin, or the name's first letter in white
   * on the brand color (ST2's letter mark).
   */
  async icon(slug: string, size: number): Promise<Buffer> {
    const shop = await this.shopOf(slug);
    const brand = await receiptSettingsOf(this.db, shop.merchantId);
    const logo = brand?.logoFileId
      ? await this.files.serve(brand.logoFileId, 'merchant_logo')
      : null;
    if (logo) {
      const inner = Math.round(size * 0.8);
      const fitted = await sharp(await logo.read())
        .resize(inner, inner, { fit: 'contain', background: '#FFFFFF' })
        .png()
        .toBuffer();
      return sharp({
        create: { width: size, height: size, channels: 4, background: '#FFFFFF' },
      })
        .composite([{ input: fitted, gravity: 'center' }])
        .png()
        .toBuffer();
    }
    await loadFonts();
    const letter = await textBlock(escapeMarkup(letterOf(shop.displayName)), size * 0.5, size, {
      color: '#FFFFFF',
      weight: 700,
    });
    return sharp({
      create: { width: size, height: size, channels: 4, background: shop.brandColor },
    })
      .composite([{ input: letter.data, gravity: 'center' }])
      .png()
      .toBuffer();
  }

  /** SP3: one page view of the shop, a bot's aside; counters only, no personal data. */
  async countVisit(slug: string, userAgent: string | null): Promise<void> {
    if (isBotUserAgent(userAgent)) return;
    const shop = await this.shopOf(slug);
    await this.db
      .insert(shopDailyStats)
      .values({ shopId: shop.id, damascusDate: zoneDate(new Date()), visits: 1 })
      .onConflictDoUpdate({
        target: [shopDailyStats.shopId, shopDailyStats.damascusDate],
        set: { visits: sql`${shopDailyStats.visits} + 1` },
      });
  }

  /** The shop as its pages show it (PR4, SH6: the suspension's category, never the note). */
  async publicShop(shop: ShopRow): Promise<ShopPublic> {
    const [brand, { rate }] = await readAll(this.db, [
      () => receiptSettingsOf(this.db, shop.merchantId),
      () => shopRateNow(this.db, shop),
    ]);
    return {
      id: shop.id,
      slug: shop.slug,
      name: shop.displayName,
      logoUrl: brand?.logoFileId ? `/api/shops/${shop.slug}/logo?v=${brand.logoFileId}` : null,
      letter: letterOf(shop.displayName),
      brandColor: shop.brandColor,
      announcement: shop.announcement,
      status: shop.status as ShopPublic['status'],
      suspendReason: shop.status === 'suspended' ? shop.suspendReason : null,
      rate,
      whatsapp: brand?.showWhatsapp ? brand.whatsapp : null,
    };
  }

  private async hiddenGames(shopId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ gameId: merchantShopHiddenGames.gameId })
      .from(merchantShopHiddenGames)
      .where(eq(merchantShopHiddenGames.shopId, shopId));
    return new Set(rows.map((row) => row.gameId));
  }

  /** S23 OP5 for the shop: the merchant's tier's early access, none once closed. */
  private async earlyAccess(shop: ShopRow): Promise<boolean> {
    return shop.status !== 'closed' && merchantEarlyAccess(this.db, shop.merchantId);
  }

  /** PR1, SH7: the merchant's effective list, or the list stored at the close. */
  private async priceListOf(shop: ShopRow): Promise<string> {
    if (shop.status === 'closed') {
      if (shop.priceListIdAtClose === null) throw notFound();
      return shop.priceListIdAtClose;
    }
    const pricing = await accountPriceList(this.db, shop.merchantId);
    if (!pricing) throw notFound();
    return pricing.effectiveList.id;
  }
}

/** ST2: the shop name's first letter (its first grapheme), for the letter mark. */
export function letterOf(name: string): string {
  return [...name.trim()][0] ?? '؟';
}
