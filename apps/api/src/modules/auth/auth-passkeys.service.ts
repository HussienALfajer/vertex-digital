import { Inject, Injectable } from '@nestjs/common';
import {
  defaultPasskeyName,
  describeUserAgent,
  PASSKEY_GRANT_SECONDS,
  PASSKEYS_MAX,
  type Passkey,
  type PasskeyDeviceType,
  passkeyGrantIdentifier,
} from '@vertex-digital/contracts';
import {
  customerPasskeyRows,
  customerPasskeys,
  customerSessions,
  customers,
  customerVerifications,
  type Database,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, count, eq, gt, lt } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { NotificationsService } from '../notifications/index.js';
import { AuthAccountService } from './auth-account.service.js';

/** The signed-in customer and the session a passkey grant belongs to. */
export interface PasskeyHolder {
  id: string;
  email: string;
  sessionId: string;
}

/** A credential the authenticator proved at registration (`passkeys.plugin.ts`). */
export interface NewCredential {
  credentialId: string;
  /** The COSE public key, base64. */
  publicKey: string;
  counter: number;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  transports: string | null;
  aaguid: string | null;
}

/** What the sign-in ceremony needs of a stored passkey. */
export interface StoredPasskey {
  id: string;
  customerId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
}

const grantMissing = () =>
  new CodedException(403, 'REAUTHENTICATION_REQUIRED', 'Confirm the password first');

const limitReached = () =>
  new CodedException(409, 'PASSKEYS_LIMIT_REACHED', 'The account has 10 passkeys');

const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such passkey');

const rowOf = (row: Awaited<ReturnType<typeof customerPasskeyRows>>[number]): Passkey => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

/**
 * Customer passkeys (S22 PK1–PK6, ADR 0037). The WebAuthn ceremonies are Better Auth endpoints
 * (`passkeys.plugin.ts`); the rows, the registration grant, the limit, the audit entries and the
 * email are written here, each change in one transaction.
 */
@Injectable()
export class AuthPasskeysService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly accounts: AuthAccountService,
    private readonly notifications: NotificationsService,
  ) {}

  /** `GET /api/account/passkeys` (PK4). */
  async list(customerId: string): Promise<Passkey[]> {
    return (await customerPasskeyRows(this.db, customerId)).map(rowOf);
  }

  /**
   * `POST /api/account/passkeys/authorize` (PK2): the password, counted with C11's checks, opens
   * this session's registration for 5 minutes. A second grant replaces the first.
   */
  async authorize(holder: PasskeyHolder, password: string): Promise<void> {
    await this.accounts.checkCurrentPassword(holder.id, password);
    const identifier = passkeyGrantIdentifier(holder.sessionId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(customerVerifications)
        .where(eq(customerVerifications.identifier, identifier));
      await tx.insert(customerVerifications).values({
        identifier,
        value: holder.id,
        expiresAt: new Date(Date.now() + PASSKEY_GRANT_SECONDS * 1000),
      });
    });
  }

  /**
   * PK2, before the registration options: this session holds a live grant and the account has
   * room. Checked again, under the customer's lock, when the passkey is written.
   */
  async assertCanRegister(holder: PasskeyHolder): Promise<string[]> {
    const [grant] = await this.db
      .select({ id: customerVerifications.id })
      .from(customerVerifications)
      .where(this.liveGrant(holder));
    if (!grant) throw grantMissing();
    const rows = await this.db
      .select({ credentialId: customerPasskeys.credentialId })
      .from(customerPasskeys)
      .where(eq(customerPasskeys.customerId, holder.id));
    if (rows.length >= PASSKEYS_MAX) throw limitReached();
    return rows.map((row) => row.credentialId);
  }

  /**
   * PK2: in one transaction, under the customer's lock: the session still open, the grant taken
   * (used once), room for one more, the row, the audit entry and the security email.
   */
  async register(holder: PasskeyHolder, credential: NewCredential, meta: RequestMeta) {
    const device = describeUserAgent(meta.userAgent);
    const name = defaultPasskeyName(device);
    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, holder.id))
          .for('update');
        await this.assertSessionOpen(tx, holder);
        const taken = await tx
          .delete(customerVerifications)
          .where(this.liveGrant(holder))
          .returning({ id: customerVerifications.id });
        if (taken.length === 0) throw grantMissing();
        const [held] = await tx
          .select({ total: count() })
          .from(customerPasskeys)
          .where(eq(customerPasskeys.customerId, holder.id));
        if ((held?.total ?? 0) >= PASSKEYS_MAX) throw limitReached();
        const [row] = await tx
          .insert(customerPasskeys)
          .values({ customerId: holder.id, name, ...credential })
          .returning({ id: customerPasskeys.id });
        if (!row) throw new Error('The passkey row was not written');
        await recordAudit(tx, {
          action: 'customer.passkey_added',
          ...this.byCustomer(holder.id, meta),
          details: { id: row.id, name },
        });
        await this.notifications.queueEmail(tx, {
          to: holder.email,
          template: 'customer_passkey_added',
          params: {
            at: new Date().toISOString(),
            name,
            browser: device.browser,
            system: device.system,
            ipAddress: meta.ipAddress,
          },
          customerId: holder.id,
        });
        return { id: row.id, name };
      });
    } catch (error) {
      // The authenticator already holds this credential for this store (another account's, or a
      // race of two registrations): `excludeCredentials` keeps an honest browser from it.
      if (isUniqueViolation(error)) {
        throw new CodedException(400, 'VALIDATION_FAILED', 'The passkey is already registered');
      }
      throw error;
    }
  }

  /** `PATCH /api/account/passkeys/:id` (PK4): the customer's own passkey, or `NOT_FOUND`. */
  async rename(customerId: string, id: string, name: string): Promise<Passkey> {
    const [renamed] = await this.db
      .update(customerPasskeys)
      .set({ name })
      .where(and(eq(customerPasskeys.id, id), eq(customerPasskeys.customerId, customerId)))
      .returning({ id: customerPasskeys.id });
    if (!renamed) throw notFound();
    const row = (await customerPasskeyRows(this.db, customerId)).find((item) => item.id === id);
    if (!row) throw notFound();
    return rowOf(row);
  }

  /** `DELETE /api/account/passkeys/:id` (PK4): no password; the row goes, the audit keeps it. */
  async remove(customerId: string, id: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(customerPasskeys)
        .where(and(eq(customerPasskeys.id, id), eq(customerPasskeys.customerId, customerId)))
        .returning({ id: customerPasskeys.id, name: customerPasskeys.name });
      if (!removed) throw notFound();
      await recordAudit(tx, {
        action: 'customer.passkey_removed',
        ...this.byCustomer(customerId, meta),
        details: { id: removed.id, name: removed.name },
      });
    });
  }

  /** PK3: the passkey a sign-in assertion names, or null. */
  async byCredential(credentialId: string): Promise<StoredPasskey | null> {
    const [row] = await this.db
      .select({
        id: customerPasskeys.id,
        customerId: customerPasskeys.customerId,
        publicKey: customerPasskeys.publicKey,
        counter: customerPasskeys.counter,
        transports: customerPasskeys.transports,
      })
      .from(customerPasskeys)
      .where(eq(customerPasskeys.credentialId, credentialId));
    return row ?? null;
  }

  /**
   * PK3, after a verified assertion: the new counter and the last use. A counter above zero must
   * be above the stored one, also against a parallel sign-in with the same value. `regressed`
   * when the row refused it (a cloned authenticator); `gone` when it was removed meanwhile (a
   * reset or a removal), which is no alert.
   */
  async recordUse(
    passkey: StoredPasskey,
    newCounter: number,
  ): Promise<'used' | 'regressed' | 'gone'> {
    const updated = await this.db
      .update(customerPasskeys)
      .set({ counter: newCounter, lastUsedAt: new Date() })
      .where(
        and(
          eq(customerPasskeys.id, passkey.id),
          newCounter === 0
            ? eq(customerPasskeys.counter, 0)
            : lt(customerPasskeys.counter, newCounter),
        ),
      )
      .returning({ id: customerPasskeys.id });
    if (updated.length > 0) return 'used';
    return (await this.stillHeld(passkey.id)) ? 'regressed' : 'gone';
  }

  /**
   * PK5 after a passkey session is made: the passkey still exists. A reset holds the customer
   * `FOR UPDATE` until it has deleted the sessions and the passkeys, and the new session's foreign
   * key waits on that lock, so a session made beside a reset either is deleted by it or finds the
   * passkey gone here (the 2026-10-15 audit's verify-email race, for passkeys).
   */
  async stillHeld(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: customerPasskeys.id })
      .from(customerPasskeys)
      .where(eq(customerPasskeys.id, id));
    return row !== undefined;
  }

  private liveGrant(holder: PasskeyHolder) {
    return and(
      eq(customerVerifications.identifier, passkeyGrantIdentifier(holder.sessionId)),
      eq(customerVerifications.value, holder.id),
      gt(customerVerifications.expiresAt, new Date()),
    );
  }

  /** Edge case 19: a reset signs the session out, and its grant goes with it. */
  private async assertSessionOpen(tx: Transaction, holder: PasskeyHolder): Promise<void> {
    const [session] = await tx
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.id, holder.sessionId),
          eq(customerSessions.userId, holder.id),
          gt(customerSessions.expiresAt, new Date()),
        ),
      );
    if (!session) throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
  }

  private byCustomer(customerId: string, meta: RequestMeta) {
    return {
      actorKind: 'customer',
      actorId: customerId,
      channel: 'store',
      entityType: 'customer',
      entityId: customerId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
