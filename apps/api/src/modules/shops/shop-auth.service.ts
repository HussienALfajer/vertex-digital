import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { type Database, merchantShops } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { and, desc, eq, inArray } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { ShopAccountsService, type ShopOfRequest } from './shop-accounts.service.js';
import {
  createShopAuth,
  SHOP_AUTH_BASE_PATH,
  SHOP_AUTH_NEST_PATHS,
  type ShopAuth,
} from './shop-auth.config.js';
import { currentShopId, inShop } from './shop-scope.js';

/** The signed-in shop customer of a request, as the access guard sees them. */
export interface ShopCustomerIdentity {
  id: string;
  shopId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  frozen: boolean;
  archived: boolean;
  sessionId: string;
}

/** Shops whose pages and accounts answer (S26 Access): not a request or a rejected one. */
const OPEN_STATUSES = ['active', 'suspended', 'closed'] as const;

/** Owns the shop customers' Better Auth instance (ADR 0040): its handler and session reads. */
@Injectable()
export class ShopAuthService {
  readonly auth: ShopAuth;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
    accounts: ShopAccountsService,
    altcha: AltchaService,
  ) {
    this.auth = createShopAuth(
      db,
      env,
      accounts,
      async () => {
        const shop = await this.shopById(currentShopId());
        if (!shop) throw new Error('The scoped shop is gone');
        return shop;
      },
      (header) => altcha.verify(header),
    );
  }

  /** The open shop that holds this slug now (an old slug is not a shop of the API), or null. */
  async shopBySlug(slug: string): Promise<ShopOfRequest | null> {
    const [row] = await this.db
      .select(SHOP_COLUMNS)
      .from(merchantShops)
      .where(
        and(
          eq(merchantShops.slug, slug.toLowerCase()),
          inArray(merchantShops.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(desc(merchantShops.requestedAt))
      .limit(1);
    return row ?? null;
  }

  async shopById(id: string): Promise<ShopOfRequest | null> {
    const [row] = await this.db
      .select(SHOP_COLUMNS)
      .from(merchantShops)
      .where(eq(merchantShops.id, id));
    return row ?? null;
  }

  /**
   * The Express handler for `/api/shops/:slug/auth/*` (`app.setup.ts`): the slug's shop scopes
   * the request, the Nest paths go on to their routes, and Better Auth sees its own base path.
   */
  handler() {
    const betterAuth = toNodeHandler(this.auth);
    const nestPaths = new Set<string>(SHOP_AUTH_NEST_PATHS);
    return async (
      request: IncomingMessage & { params?: { slug?: string }; originalUrl?: string },
      response: ServerResponse,
      next: (error?: unknown) => void,
    ) => {
      try {
        const url = request.originalUrl ?? request.url ?? '';
        const match = /^\/api\/shops\/([^/?#]+)\/auth(\/[^?#]*)?(\?.*)?$/.exec(url);
        const rest = (match?.[2] ?? '/').replace(/[/]+$/, '') || '/';
        if (!match || nestPaths.has(rest.toLowerCase())) return next();
        const shop = await this.shopBySlug(decodeURIComponent(match[1] ?? ''));
        if (!shop) {
          response.statusCode = 404;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({ statusCode: 404, code: 'NOT_FOUND', message: 'No such shop' }),
          );
          return;
        }
        const target = `${SHOP_AUTH_BASE_PATH}${rest}${match[3] ?? ''}`;
        request.url = target;
        request.originalUrl = target;
        await inShop(shop.id, () => betterAuth(request, response));
      } catch (error) {
        next(error);
      }
    };
  }

  /** The shop customer of the request's shop session, or null (another shop's session is none). */
  async shopCustomerOf(
    headers: IncomingHttpHeaders,
    shopId: string,
  ): Promise<ShopCustomerIdentity | null> {
    const session = await inShop(shopId, () =>
      this.auth.api.getSession({ headers: fromNodeHeaders(headers) }),
    );
    if (!session) return null;
    const user = session.user as typeof session.user & {
      shopId?: string;
      frozenAt?: Date | null;
      archivedAt?: Date | null;
    };
    if (user.shopId !== shopId) return null;
    return {
      id: user.id,
      shopId,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      frozen: Boolean(user.frozenAt),
      archived: Boolean(user.archivedAt),
      sessionId: session.session.id,
    };
  }
}

const SHOP_COLUMNS = {
  id: merchantShops.id,
  slug: merchantShops.slug,
  displayName: merchantShops.displayName,
  status: merchantShops.status,
  customerLimit: merchantShops.customerLimit,
};
