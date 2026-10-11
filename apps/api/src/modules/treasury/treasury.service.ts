import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateSupplierCorrection,
  type CreateTreasuryMovement,
  correctionEndpoints,
  type MoneyPlaces,
  type ReverseTreasuryMovement,
  sypToUsd,
  TREASURY_ACCOUNTS,
  type TreasuryEndpoint,
  type TreasuryMovement,
  type TreasuryMovementPage,
  type TreasuryMovementQuery,
  treasuryConfirmationError,
  treasuryMovementError,
} from '@vertex-digital/contracts';
import {
  type Database,
  LedgerError,
  type MovementInput,
  type MovementView,
  moneyPlaces,
  orderIdByNumber,
  recordMovement,
  reverseMovement,
  TreasuryError,
  treasuryMovements,
  treasuryMovementView,
  treasuryMovementViews,
} from '@vertex-digital/db';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { after, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';
import { RatesService } from '../rates/index.js';

interface Written {
  movement: TreasuryMovement;
  /** False on a replay of the key's first request: nothing was written. */
  created: boolean;
}

/** The HTTP status of each coded refusal of the treasury write path (S13 "API"). */
const STATUS = {
  NOT_FOUND: 404,
  OPENING_BALANCE_EXISTS: 409,
  EXTERNAL_REFERENCE_TAKEN: 409,
  MOVEMENT_ALREADY_REVERSED: 409,
  MOVEMENT_NOT_REVERSIBLE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
} as const;

function coded(error: unknown): unknown {
  if (error instanceof TreasuryError || error instanceof LedgerError) {
    const status = (STATUS as Partial<Record<string, 404 | 409>>)[error.code] ?? 409;
    return new CodedException(status, error.code, error.message, error.details ?? undefined);
  }
  return error;
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such movement');

/**
 * Treasury movements (S13 rules T1–T10, M1–M5), owned by this module: the money places, the
 * movements list, transfers, supplier corrections and reversals. The pure rules of the contracts
 * are checked here; the write path of `packages/db` locks, posts, writes and audits in one
 * transaction (rule T7: re-authentication on the route, the typed confirmation above $100).
 */
@Injectable()
export class TreasuryService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
    private readonly rates: RatesService,
  ) {}

  places(): Promise<MoneyPlaces> {
    return moneyPlaces(this.db);
  }

  async movements(query: TreasuryMovementQuery): Promise<TreasuryMovementPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await treasuryMovementViews(this.db, {
      place: query.place,
      after: cursor ? after(treasuryMovements.createdAt, treasuryMovements.id, cursor) : undefined,
      limit: query.limit + 1,
    });
    const page = pageOf(rows, query.limit, (row) => ({ at: row.at, id: row.id }));
    return { items: await this.withNames(page.items), nextCursor: page.nextCursor };
  }

  /** Rule T2–T8: a transfer between two places. */
  async create(
    adminId: string,
    idempotencyKey: string,
    body: CreateTreasuryMovement & { openingBalance: boolean },
    meta: RequestMeta,
  ): Promise<Written> {
    const refusal = treasuryMovementError(body);
    if (refusal) {
      throw new CodedException(400, refusal, 'The movement cannot be recorded as asked');
    }
    await this.checkConfirmation(body.from, body.sentUnits, body.amountConfirmationUnits);
    return this.write(adminId, meta, {
      idempotencyKey,
      kind: 'transfer',
      from: body.from,
      to: body.to,
      sentUnits: body.sentUnits,
      receivedUnits: body.receivedUnits,
      outsideCategory: body.outsideCategory ?? null,
      openingBalance: body.openingBalance,
      orderId: null,
      externalReference: body.externalReference ?? null,
      reason: body.reason,
    });
  }

  /** Rule T5: a supplier balance correction, optionally about one order. */
  async correct(
    adminId: string,
    idempotencyKey: string,
    body: CreateSupplierCorrection,
    meta: RequestMeta,
  ): Promise<Written> {
    await this.checkConfirmation(
      'supplier_corrections',
      body.amountUnits,
      body.amountConfirmationUnits,
    );
    let orderId: string | null = null;
    if (body.orderNumber) {
      orderId = await orderIdByNumber(this.db, body.orderNumber);
      if (!orderId) throw new CodedException(404, 'NOT_FOUND', 'No order with this number');
    }
    return this.write(adminId, meta, {
      idempotencyKey,
      kind: 'supplier_correction',
      ...correctionEndpoints(body.supplier, body.direction),
      sentUnits: body.amountUnits,
      receivedUnits: body.amountUnits,
      outsideCategory: null,
      openingBalance: false,
      orderId,
      externalReference: body.externalReference ?? null,
      reason: body.reason,
    });
  }

  /** Rule T9: the reversal of a movement, once. */
  async reverse(
    adminId: string,
    movementId: string,
    idempotencyKey: string,
    body: ReverseTreasuryMovement,
    meta: RequestMeta,
  ): Promise<Written> {
    const original = isUuid(movementId) ? await treasuryMovementView(this.db, movementId) : null;
    if (!original) throw notFound();
    await this.checkConfirmation(original.from, original.sentUnits, body.amountConfirmationUnits);
    const result = await this.db
      .transaction((tx) =>
        reverseMovement(
          tx,
          { movementId, idempotencyKey, reason: body.reason },
          { adminId, ...meta },
        ),
      )
      .catch((error: unknown) => {
        throw coded(error);
      });
    return { movement: await this.view(result.movement.id), created: result.created };
  }

  /** Rule T7: the sent amount typed again when worth more than $100 (SYP at today's rate). */
  private async checkConfirmation(
    from: TreasuryEndpoint,
    sentUnits: number,
    confirmationUnits: number | undefined,
  ): Promise<void> {
    let usdValue: number | null = sentUnits;
    if (TREASURY_ACCOUNTS[from].currency === 'SYP') {
      const rate = await this.rates.current();
      usdValue = rate ? sypToUsd(sentUnits, rate.sypPerUsd, 'up') : null;
    }
    const refusal = treasuryConfirmationError(sentUnits, usdValue, confirmationUnits);
    if (refusal) {
      throw new CodedException(400, refusal, 'The amount must be typed again to confirm it');
    }
  }

  private async write(adminId: string, meta: RequestMeta, input: MovementInput): Promise<Written> {
    const result = await this.db
      .transaction((tx) => recordMovement(tx, input, { adminId, ...meta }))
      .catch((error: unknown) => {
        throw coded(error);
      });
    return { movement: await this.view(result.movement.id), created: result.created };
  }

  private async view(id: string): Promise<TreasuryMovement> {
    const view = await treasuryMovementView(this.db, id);
    if (!view) throw new Error(`Movement ${id} was written but cannot be read`);
    const [movement] = await this.withNames([view]);
    return movement as TreasuryMovement;
  }

  private async withNames(rows: MovementView[]): Promise<TreasuryMovement[]> {
    const names = await this.admins.namesOf([...new Set(rows.map((row) => row.adminId))]);
    return rows.map(({ adminId, at: _at, ...row }) => ({
      ...row,
      adminName: names.get(adminId) ?? null,
    }));
  }
}
