import { Inject, Injectable } from '@nestjs/common';
import {
  type CodeReleaseRequest,
  MERCHANT_CODE_RELEASES_PER_TEN_MINUTES,
  type OrderPrint,
  type PublicVerification,
  type ReleasedCodes,
  verificationCodeSchema,
} from '@vertex-digital/contracts';
import {
  applicant,
  type Database,
  orderCodesKey,
  orderPrint,
  publicVerification,
  releaseCodes,
  withinLimits,
} from '@vertex-digital/db';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { codesFileName, codesWorkbook } from './codes-workbook.js';
import { asCodedException, orderRefusals } from './order-errors.js';

const TEN_MINUTES = 10 * 60 * 1000;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** A release as the controller sends it: the codes as JSON, or the `.xlsx` of an export. */
export type Release =
  | { kind: 'codes'; codes: ReleasedCodes }
  | { kind: 'file'; fileName: string; body: Buffer };

/**
 * Receipts, printing and verification (S21 F34, F35): a merchant's code releases to print, copy
 * or export (CR1–CR3), each logged per code like a reveal; the printed receipt's data (PR2, BR1);
 * the public verification page by its code (VF2, VF3). None of them shows the price a merchant
 * paid.
 */
@Injectable()
export class OrderReceiptsService {
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  /**
   * CR1–CR3: the merchant's own order's delivered codes; 20 releases per 10 minutes. A customer is
   * `NOT_MERCHANT`; another account's order is not found.
   */
  async release(
    customerId: string,
    orderId: string,
    request: CodeReleaseRequest,
    meta: RequestMeta,
  ): Promise<Release> {
    if (!isUuid(orderId)) throw orderRefusals.notFound();
    const person = await applicant(this.db, customerId);
    if (person?.accountType !== 'merchant') {
      throw new CodedException(403, 'NOT_MERCHANT', 'The account is not a merchant');
    }
    const allowed = await withinLimits(this.db, [
      {
        // CR3: the same counter as the merchant's single reveals.
        key: `reveal:customer:${customerId}`,
        max: MERCHANT_CODE_RELEASES_PER_TEN_MINUTES,
        windowMs: TEN_MINUTES,
      },
    ]);
    if (!allowed) throw orderRefusals.rateLimited();
    const released = await this.db
      .transaction((tx) =>
        releaseCodes(tx, this.codesKey, {
          orderId,
          customerId,
          purpose: request.purpose,
          ...(request.codeIds && { codeIds: request.codeIds }),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        }),
      )
      .catch((error: unknown) => {
        throw asCodedException(error);
      });
    if (!released) throw orderRefusals.notFound();
    if (request.purpose !== 'export') return { kind: 'codes', codes: { codes: released.codes } };
    const print = (await orderPrint(this.db, customerId, orderId)) as OrderPrint;
    return {
      kind: 'file',
      fileName: codesFileName(print.orderNumber),
      body: await codesWorkbook(print, released.codes),
    };
  }

  /** PR2, BR1: the customer's own order as a printed receipt. */
  async print(customerId: string, orderId: string): Promise<OrderPrint> {
    const print = isUuid(orderId) ? await orderPrint(this.db, customerId, orderId) : null;
    if (!print) throw orderRefusals.notFound();
    return print;
  }

  /** VF2, VF3: the order behind a verification code; one `NOT_FOUND` for any unknown code. */
  async verify(code: string): Promise<PublicVerification> {
    const page = verificationCodeSchema.safeParse(code).success
      ? await publicVerification(this.db, code)
      : null;
    if (!page) throw orderRefusals.notFound();
    return page;
  }
}
