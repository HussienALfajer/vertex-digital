import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminOrder,
  type PublicShare,
  type ReceiptOptions,
  SHAREABLE_ORDER_STATUSES,
  type ShareLink,
  shareTokenSchema,
} from '@vertex-digital/contracts';
import {
  adminOrder,
  createShareLink,
  type Database,
  lockOrder,
  orderShareLinks,
  publicShare,
  recordAudit,
  type ShareLinkRow,
  sharePath,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { withinLimits } from '../auth/index.js';
import { FilesService } from '../files/index.js';
import { orderRefusals } from './order-errors.js';
import { renderShareImage, type ShareImageFormat } from './share-image.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const HOUR = 60 * 60 * 1000;

/** The cover width the image draws from: the stored WebP variant (S09 rule SF5). */
const COVER_WIDTH = 640;

/**
 * Share links (S10 rules GF4, RC1–RC3, SH1, SH2, AD1): the customer's receipt and gift links on
 * their own orders (20 changes per hour), the public page data and image of a live token, and the
 * admin's revocation with its audit entry. Links are never deleted: a revocation is final, and a
 * new link is a new token.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly files: FilesService,
  ) {}

  /** Rule RC1: creates the receipt link, or changes the live one's choices (same token). */
  async receiptLink(
    customerId: string,
    orderId: string,
    options: Required<ReceiptOptions>,
  ): Promise<ShareLink> {
    await this.limit(customerId);
    const link = await this.db.transaction(async (tx) => {
      await this.ownShareableOrder(tx, customerId, orderId);
      const [live] = await tx
        .update(orderShareLinks)
        .set({ showPrice: options.showPrice, playerDisplay: options.playerDisplay })
        .where(this.liveLink(orderId, 'receipt'))
        .returning();
      return live ?? createShareLink(tx, { orderId, kind: 'receipt', ...options });
    });
    return this.view(link);
  }

  /** Rule GF4: "رابط جديد" after a revocation; a live gift link is `link_exists`. */
  async giftLink(customerId: string, orderId: string): Promise<ShareLink> {
    await this.limit(customerId);
    const link = await this.db.transaction(async (tx) => {
      const order = await this.ownShareableOrder(tx, customerId, orderId);
      if (!order.isGift) throw orderRefusals.notShareable('not_gift');
      const [live] = await tx.select().from(orderShareLinks).where(this.liveLink(orderId, 'gift'));
      if (live) throw orderRefusals.notShareable('link_exists');
      return createShareLink(tx, { orderId, kind: 'gift' });
    });
    return this.view(link);
  }

  /** Rule RC3: the customer revokes an own link; a revoked link answers the same. */
  async revoke(customerId: string, orderId: string, linkId: string): Promise<void> {
    if (!isUuid(orderId) || !isUuid(linkId)) throw orderRefusals.notFound();
    await this.limit(customerId);
    await this.db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order?.customerId !== customerId) throw orderRefusals.notFound();
      const link = await this.lockLink(tx, orderId, linkId);
      if (link.revokedAt) return;
      await tx
        .update(orderShareLinks)
        .set({ revokedAt: sql`now()`, revokedBy: 'customer' })
        .where(eq(orderShareLinks.id, linkId));
    });
  }

  /** Rule AD1: the admin revokes a link with a reason, audited; no re-authentication. */
  async adminRevoke(
    actor: { adminId: string; meta: RequestMeta },
    orderId: string,
    linkId: string,
    reason: string,
  ): Promise<AdminOrder> {
    if (!isUuid(orderId) || !isUuid(linkId)) throw orderRefusals.notFound();
    await this.db.transaction(async (tx) => {
      const link = await this.lockLink(tx, orderId, linkId);
      if (link.revokedAt) return;
      await tx
        .update(orderShareLinks)
        .set({ revokedAt: sql`now()`, revokedBy: 'admin', revokeReason: reason })
        .where(eq(orderShareLinks.id, linkId));
      await recordAudit(tx, {
        action: 'order.share_revoked',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'order',
        entityId: orderId,
        reason,
        details: { linkId, kind: link.kind },
        ...actor.meta,
      });
    });
    return (await adminOrder(this.db, orderId)) as AdminOrder;
  }

  /** Rule SH1: a live link's page data; an unknown or revoked token is not found. */
  async publicShare(token: string): Promise<PublicShare> {
    return (await this.share(token)).share;
  }

  /** Rule SH2: the link's image, rendered on each request (HTTP caches it). */
  async image(token: string, format: ShareImageFormat): Promise<Buffer> {
    const { share, coverFileId } = await this.share(token);
    const cover = coverFileId ? await this.files.catalogVariant(coverFileId, COVER_WIDTH) : null;
    return renderShareImage(
      share,
      format,
      cover ? await cover.read() : null,
      `${this.env.STORE_URL}${sharePath(share.kind, token)}`,
    );
  }

  private async share(token: string) {
    const found = shareTokenSchema.safeParse(token).success
      ? await publicShare(this.db, token)
      : null;
    if (!found) throw orderRefusals.notFound();
    return found;
  }

  private async limit(customerId: string) {
    const allowed = await withinLimits(this.db, [
      { key: `share:customer:${customerId}`, max: 20, windowMs: HOUR },
    ]);
    if (!allowed) throw orderRefusals.rateLimited();
  }

  /** The customer's order, locked (one link change at a time), in a status a link may show. */
  private async ownShareableOrder(tx: Transaction, customerId: string, orderId: string) {
    const order = isUuid(orderId) ? await lockOrder(tx, orderId) : null;
    if (order?.customerId !== customerId) throw orderRefusals.notFound();
    if (!SHAREABLE_ORDER_STATUSES.includes(order.status)) {
      throw orderRefusals.notShareable('status');
    }
    return order;
  }

  private liveLink(orderId: string, kind: 'gift' | 'receipt') {
    return and(
      eq(orderShareLinks.orderId, orderId),
      eq(orderShareLinks.kind, kind),
      isNull(orderShareLinks.revokedAt),
    );
  }

  private async lockLink(tx: Transaction, orderId: string, linkId: string) {
    const [link] = await tx
      .select()
      .from(orderShareLinks)
      .where(and(eq(orderShareLinks.id, linkId), eq(orderShareLinks.orderId, orderId)))
      .for('update');
    if (!link) throw orderRefusals.notFound();
    return link;
  }

  private view(link: ShareLinkRow): ShareLink {
    return {
      id: link.id,
      kind: link.kind,
      url: `${this.env.STORE_URL}${sharePath(link.kind, link.token)}`,
      showPrice: link.showPrice,
      playerDisplay: link.playerDisplay,
      createdAt: link.createdAt.toISOString(),
    };
  }
}
