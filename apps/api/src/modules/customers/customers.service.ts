import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminCustomer,
  type AdminCustomerPage,
  type AdminMerchantTier,
  type AuditPage,
  type CursorQuery,
  type CustomerLimitOverrides,
  type CustomerLimits,
  type CustomerNote,
  type CustomerNoteListQuery,
  type CustomerNotePage,
  type CustomerSearchQuery,
  type CustomerSession,
  type CustomerSignInPage,
  classifyCustomerSearch,
  customerLimits as customerLimitsOf,
  customerStatus,
  DEPOSIT_SETTINGS_DEFAULTS,
  type LevelTier,
  type Passkey,
  type SetCustomerPriceList,
  type UpdateCustomerLimits,
} from '@vertex-digital/contracts';
import {
  type AcceptedVersion,
  type AccountPriceList,
  type AdminActor,
  accountPriceList,
  archiveCustomer,
  CustomerError,
  customerAcceptedVersions,
  customerActiveSessions,
  customerHistoryScope,
  customerLimitOverrides,
  customerNotes,
  customerPage,
  customerPasskeyRows,
  customerProfileFacts,
  customerSignals,
  customerSignInRows,
  type Database,
  findCustomer,
  freezeCustomer,
  lockCustomer,
  merchantDepositTier,
  merchantProfileOf,
  recordAudit,
  revokeCustomerSessions,
  setCustomerLimits,
  setCustomerPriceList,
  type Transaction,
  unarchiveCustomer,
  unfreezeCustomer,
} from '@vertex-digital/db';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuditService } from '../audit/index.js';
import { DepositSettingsService } from '../deposits/index.js';

const acceptedView = (accepted: AcceptedVersion | null) =>
  accepted && { version: accepted.version, publishedAt: accepted.publishedAt.toISOString() };

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such customer');

/** The HTTP status of each coded refusal of the customer write paths (S12 "API"). */
const STATUS = {
  NOT_FOUND: 404,
  CUSTOMER_STATE_INVALID: 409,
  CUSTOMER_NOT_ARCHIVABLE: 409,
  PRICE_LIST_ARCHIVED: 409,
  PRICE_LIST_NOT_READY: 409,
  ALREADY_MERCHANT: 409,
  NOT_MERCHANT: 409,
  APPLICATION_STATE_INVALID: 409,
} as const;

/** A `CustomerError` as the API answers it; anything else is rethrown as is. */
function coded(error: unknown): unknown {
  if (error instanceof CustomerError) {
    const status = STATUS[error.code as keyof typeof STATUS] ?? 409;
    return new CodedException(status, error.code, error.message, error.details ?? undefined);
  }
  return error;
}

type NoteRow = typeof customerNotes.$inferSelect;

const noteOf = (row: NoteRow): CustomerNote => ({
  id: row.id,
  body: row.body,
  pinned: row.pinned,
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

/** The state changes of the profile's actions menu (CF1, CF6, AR1, AR3, SN1). */
export type CustomerStateAction =
  | 'freeze'
  | 'unfreeze'
  | 'archive'
  | 'unarchive'
  | 'revokeSessions';

/**
 * Customer administration (S12 F19): the search, the profile and its tabs, freezing, limits,
 * archiving, signing out everywhere and notes. The customer rows belong to the `auth` module: the
 * reads and the state changes go through `packages/db/src/customers`, which take the customer row
 * `FOR UPDATE` first, as purchases read it `FOR SHARE`.
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly depositSettings: DepositSettingsService,
  ) {}

  /** `GET /api/admin/customers` (CS1, CS2). */
  async search(query: CustomerSearchQuery): Promise<AdminCustomerPage> {
    const rows = await customerPage(this.db, {
      search: query.q ? classifyCustomerSearch(query.q) : null,
      filter: query.status,
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.id }));
    return {
      items: page.items.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        isTest: row.isTest,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        balanceUnits: row.balanceUnits,
        deliveredOrders: row.deliveredOrders,
        lastOrderAt: row.lastOrderAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /api/admin/customers/:id` (CS3, CS5). */
  async profile(id: string): Promise<AdminCustomer> {
    const customer = isUuid(id) ? await findCustomer(this.db, id) : null;
    if (!customer) throw notFound();
    const [facts, signals, overrides, pinned, accepted, pricing, merchant] = await Promise.all([
      customerProfileFacts(this.db, customer),
      customerSignals(this.db, customer.id),
      customerLimitOverrides(this.db, customer.id),
      this.pinnedNote(customer.id),
      customerAcceptedVersions(this.db, customer.id),
      accountPriceList(this.db, customer.id),
      merchantProfileOf(this.db, customer.id),
    ]);
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      emailVerified: customer.emailVerified,
      isTest: customer.isTest,
      createdAt: customer.createdAt.toISOString(),
      established: facts.established,
      status: customerStatus(customer),
      statusChange: facts.statusChange && {
        reason: facts.statusChange.reason,
        at: facts.statusChange.at.toISOString(),
      },
      limits: await this.limitsView(customer.id, facts.established, overrides),
      pricing: pricing as AccountPriceList,
      merchant: merchant && {
        ...merchant,
        termsVersion: merchant.termsVersion ?? null,
        grantedAt: merchant.grantedAt.toISOString(),
        revokedAt: merchant.revokedAt?.toISOString() ?? null,
        levelChangedAt: merchant.levelChangedAt?.toISOString() ?? null,
        tier: merchantTierView(merchant.tier),
      },
      pinnedNote: pinned && noteOf(pinned),
      balanceUnits: facts.balanceUnits,
      counts: facts.counts,
      signals,
      termsVersion: acceptedView(accepted.terms),
      privacyVersion: acceptedView(accepted.privacy),
    };
  }

  /** Rule LM3: the overrides and the limits in force with their source (S20 MD2: the tier). */
  private async limitsView(
    customerId: string,
    established: boolean,
    overrides: CustomerLimitOverrides,
  ): Promise<CustomerLimits> {
    const settings = (await this.depositSettings.current()) ?? DEPOSIT_SETTINGS_DEFAULTS;
    return customerLimitsOf(
      settings,
      established,
      overrides,
      await merchantDepositTier(this.db, customerId),
    );
  }

  /** `GET …/sign-ins`: the sign-in log, newest first (CS4). */
  async signIns(id: string, query: CursorQuery): Promise<CustomerSignInPage> {
    await this.existing(id);
    const rows = await customerSignInRows(this.db, id, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.id }));
    return {
      items: page.items.map((row) => ({
        id: row.id,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET …/sessions`: the sessions that have not expired (CS4). */
  async sessions(id: string): Promise<CustomerSession[]> {
    await this.existing(id);
    const rows = await customerActiveSessions(this.db, id);
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastActiveAt.toISOString(),
    }));
  }

  /** `GET …/passkeys` (S22 PK6): read only, never the key or the credential id. */
  async passkeys(id: string): Promise<Passkey[]> {
    await this.existing(id);
    const rows = await customerPasskeyRows(this.db, id);
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /** `GET …/history`: audit entries of the customer and their orders, deposits and tickets. */
  async history(id: string, query: CursorQuery): Promise<AuditPage> {
    await this.existing(id);
    return this.audit.list(query, customerHistoryScope(id));
  }

  /** `GET …/notes`: active notes newest first, or the archived ones (SN2). */
  async notes(id: string, query: CustomerNoteListQuery): Promise<CustomerNotePage> {
    await this.existing(id);
    const rows = await this.db
      .select({ note: customerNotes, cursorAt: cursorTime(customerNotes.createdAt) })
      .from(customerNotes)
      .where(
        and(
          eq(customerNotes.customerId, id),
          query.archived ? isNotNull(customerNotes.archivedAt) : isNull(customerNotes.archivedAt),
          query.cursor
            ? after(customerNotes.createdAt, customerNotes.id, decodeCursor(query.cursor))
            : undefined,
        ),
      )
      .orderBy(desc(customerNotes.createdAt), desc(customerNotes.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.note.id }));
    return { items: page.items.map((row) => noteOf(row.note)), nextCursor: page.nextCursor };
  }

  /**
   * S20 AT2, AT3: the account's list (null: its type's default), in one transaction with its
   * audit entry, the reservations it cancels and the customer's notice.
   */
  async setPriceList(
    id: string,
    input: SetCustomerPriceList,
    adminId: string,
    meta: RequestMeta,
  ): Promise<AdminCustomer> {
    if (!isUuid(id)) throw notFound();
    try {
      await this.db.transaction((tx) =>
        setCustomerPriceList(
          tx,
          { jobs: this.jobs },
          {
            customerId: id,
            priceListId: input.priceListId,
            reason: input.reason,
            actor: this.actor(adminId, meta),
          },
        ),
      );
    } catch (error) {
      throw coded(error);
    }
    return this.profile(id);
  }

  /** CF1, CF6, AR1–AR3, SN1: each in one transaction with its audit entry. */
  async changeState(
    action: CustomerStateAction,
    id: string,
    reason: string,
    adminId: string,
    meta: RequestMeta,
  ): Promise<AdminCustomer> {
    if (!isUuid(id)) throw notFound();
    const input = { customerId: id, reason, actor: this.actor(adminId, meta) };
    try {
      await this.db.transaction(async (tx) => {
        switch (action) {
          case 'freeze':
            await freezeCustomer(tx, { jobs: this.jobs }, input);
            return;
          case 'unfreeze':
            await unfreezeCustomer(tx, input);
            return;
          case 'archive':
            await archiveCustomer(tx, input);
            return;
          case 'unarchive':
            await unarchiveCustomer(tx, input);
            return;
          case 'revokeSessions':
            await revokeCustomerSessions(tx, input);
            return;
        }
      });
    } catch (error) {
      throw coded(error);
    }
    return this.profile(id);
  }

  /** `PUT …/limits` (LM5). */
  async setLimits(
    id: string,
    input: UpdateCustomerLimits,
    adminId: string,
    meta: RequestMeta,
  ): Promise<CustomerLimits> {
    if (!isUuid(id)) throw notFound();
    const { reason, ...limits } = input;
    try {
      await this.db.transaction((tx) =>
        setCustomerLimits(tx, {
          customerId: id,
          limits,
          reason,
          actor: this.actor(adminId, meta),
        }),
      );
    } catch (error) {
      throw coded(error);
    }
    return (await this.profile(id)).limits;
  }

  /** `POST …/notes` (SN2): a pinned note unpins the current one in the same transaction. */
  async addNote(
    id: string,
    input: { body: string; pinned: boolean },
    adminId: string,
    meta: RequestMeta,
  ): Promise<CustomerNote> {
    if (!isUuid(id)) throw notFound();
    const note = await this.db.transaction(async (tx) => {
      await this.lockExisting(tx, id);
      const unpinned = input.pinned ? await this.unpinCurrent(tx, id) : null;
      const [row] = await tx
        .insert(customerNotes)
        .values({ customerId: id, body: input.body, pinned: input.pinned })
        .returning();
      if (!row) throw new Error('The note was not written');
      await recordAudit(tx, {
        ...this.entry(adminId, meta, id),
        action: 'customer.note_added',
        details: { noteId: row.id, pinned: row.pinned },
      });
      if (unpinned) {
        await recordAudit(tx, {
          ...this.entry(adminId, meta, id),
          action: 'customer.note_unpinned',
          details: { noteId: unpinned },
        });
      }
      return row;
    });
    return noteOf(note);
  }

  /** `POST …/notes/:noteId/pin`, `…/unpin`, `…/archive` (SN2). */
  async changeNote(
    id: string,
    noteId: string,
    change: 'pin' | 'unpin' | 'archive',
    adminId: string,
    meta: RequestMeta,
  ): Promise<CustomerNote> {
    if (!isUuid(id) || !isUuid(noteId)) throw notFound();
    const note = await this.db.transaction(async (tx) => {
      await this.lockExisting(tx, id);
      const [current] = await tx
        .select()
        .from(customerNotes)
        .where(and(eq(customerNotes.id, noteId), eq(customerNotes.customerId, id)))
        .for('update');
      if (!current) throw new CodedException(404, 'NOT_FOUND', 'No such note');
      if (current.archivedAt) return current;
      if (change === 'pin') {
        if (current.pinned) return current;
        const unpinned = await this.unpinCurrent(tx, id);
        const [row] = await tx
          .update(customerNotes)
          .set({ pinned: true })
          .where(eq(customerNotes.id, noteId))
          .returning();
        await recordAudit(tx, {
          ...this.entry(adminId, meta, id),
          action: 'customer.note_pinned',
          details: { noteId, unpinnedNoteId: unpinned },
        });
        return row as NoteRow;
      }
      if (change === 'unpin') {
        if (!current.pinned) return current;
        const [row] = await tx
          .update(customerNotes)
          .set({ pinned: false })
          .where(eq(customerNotes.id, noteId))
          .returning();
        await recordAudit(tx, {
          ...this.entry(adminId, meta, id),
          action: 'customer.note_unpinned',
          details: { noteId },
        });
        return row as NoteRow;
      }
      const [row] = await tx
        .update(customerNotes)
        .set({ archivedAt: sql`now()`, pinned: false })
        .where(eq(customerNotes.id, noteId))
        .returning();
      await recordAudit(tx, {
        ...this.entry(adminId, meta, id),
        action: 'customer.note_archived',
        details: { noteId },
      });
      return row as NoteRow;
    });
    return noteOf(note);
  }

  private async pinnedNote(customerId: string): Promise<NoteRow | null> {
    const [row] = await this.db
      .select()
      .from(customerNotes)
      .where(
        and(
          eq(customerNotes.customerId, customerId),
          eq(customerNotes.pinned, true),
          isNull(customerNotes.archivedAt),
        ),
      );
    return row ?? null;
  }

  /** Unpins the customer's pinned note, if any; its id. */
  private async unpinCurrent(tx: Transaction, customerId: string): Promise<string | null> {
    const [row] = await tx
      .update(customerNotes)
      .set({ pinned: false })
      .where(
        and(
          eq(customerNotes.customerId, customerId),
          eq(customerNotes.pinned, true),
          isNull(customerNotes.archivedAt),
        ),
      )
      .returning({ id: customerNotes.id });
    return row?.id ?? null;
  }

  /** Notes of one customer are changed one at a time, under the customer's row lock. */
  private async lockExisting(tx: Transaction, customerId: string): Promise<void> {
    try {
      await lockCustomer(tx, customerId);
    } catch (error) {
      throw coded(error);
    }
  }

  private async existing(id: string): Promise<void> {
    if (!isUuid(id) || !(await findCustomer(this.db, id))) throw notFound();
  }

  private actor(adminId: string, meta: RequestMeta): AdminActor {
    return { adminId, ipAddress: meta.ipAddress, userAgent: meta.userAgent };
  }

  private entry(adminId: string, meta: RequestMeta, customerId: string) {
    return {
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType: 'customer',
      entityId: customerId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}

/** S23 AD5: the merchant's tiers and grants as the profile shows them. */
function merchantTierView(
  tier: NonNullable<Awaited<ReturnType<typeof merchantProfileOf>>>['tier'],
): AdminMerchantTier {
  const grants = tier.grants.map((grant) => ({
    id: grant.id,
    tier: grant.tier as LevelTier,
    startsAt: grant.startsAt.toISOString(),
    endsAt: grant.endsAt.toISOString(),
    reason: grant.reason,
    endedAt: grant.endedAt?.toISOString() ?? null,
    endReason: grant.endReason,
  }));
  return {
    tier: tier.tier,
    earnedTier: tier.earnedTier,
    source: tier.source,
    since: tier.since?.toISOString() ?? null,
    openGrant: grants.find((grant) => grant.endedAt === null) ?? null,
    grants,
  };
}
