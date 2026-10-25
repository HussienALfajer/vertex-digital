import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateProductAlert,
  PRODUCT_ALERTS_PER_HOUR,
  type ProductAlert,
  type ProductAlertList,
  type ProductAlertListQuery,
} from '@vertex-digital/contracts';
import {
  cancelProductAlert,
  createProductAlert,
  customerProductAlerts,
  type Database,
  ProductAlertError,
  withinLimits,
} from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';

const HOUR = 60 * 60 * 1000;

/**
 * Availability and price-drop alerts (S22 PA1, PA6, PA7) through `packages/db`, which reads the
 * pack on the customer's own effective list; the worker's `catalog.product-alerts` sends them.
 * Alerts are preferences, not audited.
 */
@Injectable()
export class ProductAlertsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(customerId: string, query: ProductAlertListQuery): Promise<ProductAlertList> {
    return { items: await customerProductAlerts(this.db, customerId, query) };
  }

  /** PA1: 30 creations an hour per customer (an existing alert answered again counts too). */
  async create(
    customerId: string,
    input: CreateProductAlert,
  ): Promise<{ alert: ProductAlert; created: boolean }> {
    const allowed = await withinLimits(this.db, [
      {
        key: `product-alerts:customer:${customerId}`,
        max: PRODUCT_ALERTS_PER_HOUR,
        windowMs: HOUR,
      },
    ]);
    if (!allowed) throw new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');
    try {
      return await this.db.transaction((tx) =>
        createProductAlert(tx, routingContext(this.env), customerId, input, new Date()),
      );
    } catch (error) {
      if (!(error instanceof ProductAlertError)) throw error;
      const status = error.code === 'NOT_FOUND' ? 404 : 409;
      throw new CodedException(status, error.code, error.message, error.details);
    }
  }

  /** PA6: another customer's or an unknown alert is not found. */
  async cancel(customerId: string, id: string): Promise<void> {
    if (!(await cancelProductAlert(this.db, customerId, id)))
      throw new CodedException(404, 'NOT_FOUND', 'No such alert');
  }
}
