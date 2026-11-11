import { Inject, Injectable } from '@nestjs/common';
import {
  PASSWORD_EQUALS_EMAIL,
  passwordEqualsEmail,
  type ShopSignUp,
  zoneDate,
} from '@vertex-digital/contracts';
import {
  type Database,
  type Limit,
  merchantShops,
  newId,
  recordAudit,
  shopAcceptedVersionsNow,
  shopCustomerAccounts,
  shopCustomerSessions,
  shopCustomers,
  shopDailyStats,
  type Transaction,
  withinLimits,
} from '@vertex-digital/db';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { NotificationsService } from '../notifications/index.js';
import {
  checkShopCode,
  issueInvitation,
  issueShopCode,
  issueShopDecoyCode,
  type ShopCodePurpose,
  takeInvitation,
} from './shop-codes.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** S01 rule C5 per shop and email: 1 a minute, 5 an hour, 10 a day; per address 20 an hour. */
const codeLimits = (shopId: string, email: string, ip: string | null): Limit[] => [
  { key: `shop:code-email-minute:${shopId}:${email}`, max: 1, windowMs: MINUTE },
  { key: `shop:code-email-hour:${shopId}:${email}`, max: 5, windowMs: HOUR },
  { key: `shop:code-email-day:${shopId}:${email}`, max: 10, windowMs: DAY },
  { key: `shop:code-ip-hour:${ip ?? 'unknown'}`, max: 20, windowMs: HOUR },
];

/** CA2: sign-ups per address (S01's 5 an hour) and per shop (50 a day). */
const signUpLimits = (shopId: string, ip: string | null): Limit[] => [
  { key: `shop:sign-up-ip-hour:${ip ?? 'unknown'}`, max: 5, windowMs: HOUR },
  { key: `shop:sign-up-shop-day:${shopId}`, max: 50, windowMs: DAY },
];

const rateLimited = () => new CodedException(429, 'RATE_LIMITED', 'Too many codes, try later');
const invalidCode = () => new CodedException(400, 'INVALID_OTP', 'The code is not valid');

/** The shop a shop realm request names, as the account paths need it. */
export interface ShopOfRequest {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  customerLimit: number;
}

/** What a verified proof hands Better Auth to open a session on. */
export interface SessionProof {
  shopCustomerId: string;
  passwordHash: string;
}

/**
 * The shop customers' accounts (S26 CA1–CA9, ADR 0040), as the customer realm's (S01): every
 * change, its audit entry and its emails in one transaction. Better Auth keeps the sign-in, the
 * cookie and the session reads; sign-up, codes, resets and invitations are here. An email is
 * unique per shop; answers never tell whether it has an account (CA3).
 */
@Injectable()
export class ShopAccountsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly notifications: NotificationsService,
  ) {}

  /** CA2, CA3, CA6: the same answer whether or not the email has an account in the shop. */
  async signUp(shop: ShopOfRequest, input: ShopSignUp, meta: RequestMeta): Promise<void> {
    if (shop.status !== 'active') {
      throw new CodedException(403, 'SHOP_UNAVAILABLE', 'The shop takes no sign-ups');
    }
    const email = input.email.trim().toLowerCase();
    if (passwordEqualsEmail(input.password, email)) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
        { path: ['password'], message: PASSWORD_EQUALS_EMAIL },
      ]);
    }
    if (!(await withinLimits(this.db, signUpLimits(shop.id, meta.ipAddress)))) throw rateLimited();
    if (!(await withinLimits(this.db, codeLimits(shop.id, email, meta.ipAddress)))) {
      throw rateLimited();
    }
    // Hashed on both paths, so the time taken does not tell whether the email has an account.
    const passwordHash = await hashPassword(input.password);
    const id = newId();
    try {
      await this.db.transaction(async (tx) => {
        // CA3, CA6: a full shop refuses every sign-up alike, known email or not.
        await this.assertRoom(tx, shop);
        const [existing] = await tx
          .select({ id: shopCustomers.id })
          .from(shopCustomers)
          .where(and(eq(shopCustomers.shopId, shop.id), eq(shopCustomers.email, email)));
        if (existing) {
          await issueShopDecoyCode(tx, 'email-verification', shop.id, email);
          return;
        }
        await tx.insert(shopCustomers).values({
          id,
          shopId: shop.id,
          name: input.name,
          email,
          phone: input.phone,
          createdBy: 'self',
          ...(await shopAcceptedVersionsNow(tx)),
        });
        await tx.insert(shopCustomerAccounts).values({
          userId: id,
          accountId: id,
          providerId: 'credential',
          password: passwordHash,
        });
        await recordAudit(tx, {
          action: 'shop_customer.created',
          ...this.byShopCustomer(id, meta),
          details: {
            shopId: shop.id,
            name: input.name,
            email,
            phone: input.phone,
            origin: 'self',
          },
        });
        // SP3: the day's sign-ups, a counter only.
        await tx
          .insert(shopDailyStats)
          .values({ shopId: shop.id, damascusDate: zoneDate(new Date()), signUps: 1 })
          .onConflictDoUpdate({
            target: [shopDailyStats.shopId, shopDailyStats.damascusDate],
            set: { signUps: sql`${shopDailyStats.signUps} + 1` },
          });
        await this.queueCode(tx, shop, 'email-verification', email);
      });
    } catch (error) {
      // The same email signed up at the same moment: answer as for an existing account.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** CA6: a shop at its customer limit takes no new account (the shop row locked to count). */
  async assertRoom(tx: Transaction, shop: { id: string; customerLimit: number }): Promise<void> {
    await tx
      .select({ id: merchantShops.id })
      .from(merchantShops)
      .where(eq(merchantShops.id, shop.id))
      .for('no key update');
    const [row] = await tx
      .select({ total: count() })
      .from(shopCustomers)
      .where(and(eq(shopCustomers.shopId, shop.id), isNull(shopCustomers.archivedAt)));
    if ((row?.total ?? 0) >= shop.customerLimit) {
      throw new CodedException(403, 'SHOP_CUSTOMER_LIMIT_REACHED', 'The shop is full');
    }
  }

  /** CA2: a new code for an unverified account of the shop; silent otherwise. */
  async sendVerificationCode(shop: ShopOfRequest, emailInput: string, meta: RequestMeta) {
    const email = emailInput.trim().toLowerCase();
    if (!(await withinLimits(this.db, codeLimits(shop.id, email, meta.ipAddress)))) {
      throw rateLimited();
    }
    await this.db.transaction(async (tx) => {
      const customer = await this.unverified(tx, shop.id, email);
      if (customer) await this.queueCode(tx, shop, 'email-verification', email);
      else await issueShopDecoyCode(tx, 'email-verification', shop.id, email);
    });
  }

  /** The code Better Auth asks for when an unverified shop customer signs in, within the limits. */
  async sendVerificationCodeOnSignIn(shop: ShopOfRequest, email: string, meta: RequestMeta) {
    await this.sendVerificationCode(shop, email, meta).catch((error: unknown) => {
      if (!(error instanceof CodedException && error.code === 'RATE_LIMITED')) throw error;
    });
  }

  /**
   * CA2: the code and the account's password verify the email (S01 rule C7, F2-7); the caller
   * signs the customer in. Only a right code reaches the password.
   */
  async verifyEmail(
    shop: ShopOfRequest,
    input: { email: string; otp: string; password: string },
    meta: RequestMeta,
  ): Promise<SessionProof> {
    const email = input.email.trim().toLowerCase();
    const outcome = await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: shopCustomers.id, emailVerified: shopCustomers.emailVerified })
        .from(shopCustomers)
        .where(
          and(
            eq(shopCustomers.shopId, shop.id),
            eq(shopCustomers.email, email),
            isNull(shopCustomers.archivedAt),
          ),
        )
        .for('update');
      if (!(await checkShopCode(tx, 'email-verification', shop.id, email, input.otp))) {
        return { ok: false } as const;
      }
      if (!customer) return { ok: false } as const;
      const hash = await this.passwordHash(tx, customer.id);
      if (!hash || !(await verifyPassword({ hash, password: input.password }))) {
        return { ok: false, mismatch: true } as const;
      }
      if (!customer.emailVerified) await this.markVerified(tx, shop.id, customer.id, meta);
      return { ok: true, id: customer.id, hash } as const;
    });
    if (!outcome.ok) {
      if ('mismatch' in outcome) {
        throw new CodedException(400, 'PASSWORD_MISMATCH', 'Another password holds the account');
      }
      throw invalidCode();
    }
    return { shopCustomerId: outcome.id, passwordHash: outcome.hash };
  }

  /** CA4: a reset code for an account of the shop; silent otherwise. */
  async requestPasswordReset(shop: ShopOfRequest, emailInput: string, meta: RequestMeta) {
    const email = emailInput.trim().toLowerCase();
    if (!(await withinLimits(this.db, codeLimits(shop.id, email, meta.ipAddress)))) {
      throw rateLimited();
    }
    await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: shopCustomers.id })
        .from(shopCustomers)
        .where(
          and(
            eq(shopCustomers.shopId, shop.id),
            eq(shopCustomers.email, email),
            isNull(shopCustomers.archivedAt),
          ),
        );
      if (customer) await this.queueCode(tx, shop, 'forget-password', email);
      else await issueShopDecoyCode(tx, 'forget-password', shop.id, email);
    });
  }

  /** CA4: sets the password, verifies the email and signs out every session of the account. */
  async resetPassword(
    shop: ShopOfRequest,
    input: { email: string; otp: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    const email = input.email.trim().toLowerCase();
    if (passwordEqualsEmail(input.password, email)) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
        { path: ['password'], message: PASSWORD_EQUALS_EMAIL },
      ]);
    }
    const passwordHash = await hashPassword(input.password);
    const done = await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: shopCustomers.id, emailVerified: shopCustomers.emailVerified })
        .from(shopCustomers)
        .where(
          and(
            eq(shopCustomers.shopId, shop.id),
            eq(shopCustomers.email, email),
            isNull(shopCustomers.archivedAt),
          ),
        )
        .for('update');
      if (!(await checkShopCode(tx, 'forget-password', shop.id, email, input.otp))) return false;
      if (!customer) return false;
      await this.setPassword(tx, shop.id, customer.id, passwordHash, meta);
      if (!customer.emailVerified) await this.markVerified(tx, shop.id, customer.id, meta);
      return true;
    });
    if (!done) throw invalidCode();
  }

  /**
   * CA8 (S01 rule C12 per shop): a code to the new address, bound to it; when the address holds
   * another account of the shop, the same answer and no email (CA3: nothing tells it is taken).
   */
  async requestEmailChange(
    shop: ShopOfRequest,
    customer: { id: string; email: string },
    input: { newEmail: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    const newEmail = input.newEmail.trim().toLowerCase();
    if (newEmail === customer.email) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
        { path: ['newEmail'], message: 'Same as the current email' },
      ]);
    }
    if (!(await withinLimits(this.db, codeLimits(shop.id, newEmail, meta.ipAddress)))) {
      throw rateLimited();
    }
    await this.db.transaction(async (tx) => {
      const hash = await this.passwordHash(tx, customer.id);
      if (!hash || !(await verifyPassword({ hash, password: input.password }))) {
        throw new CodedException(400, 'INVALID_PASSWORD', 'Wrong password');
      }
      const [taken] = await tx
        .select({ id: shopCustomers.id })
        .from(shopCustomers)
        .where(and(eq(shopCustomers.shopId, shop.id), eq(shopCustomers.email, newEmail)));
      if (taken) {
        // A code nobody receives replaces any earlier one, as a real request would.
        await issueShopDecoyCode(tx, 'change-email', shop.id, customer.id);
        return;
      }
      // One pending change per customer: a new request voids the code of an earlier address.
      const code = await issueShopCode(tx, 'change-email', shop.id, customer.id, newEmail);
      await this.notifications.queueEmail(tx, {
        to: newEmail,
        template: 'shop_customer_change_email',
        params: { shopName: shop.displayName, slug: shop.slug, code },
      });
    });
  }

  /** CA8: the code changes the email, signs out the other sessions and tells the old address. */
  async confirmEmailChange(
    shop: ShopOfRequest,
    customer: { id: string; sessionId: string },
    input: { newEmail: string; otp: string },
    meta: RequestMeta,
  ): Promise<void> {
    const newEmail = input.newEmail.trim().toLowerCase();
    let changed: boolean;
    try {
      changed = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ email: shopCustomers.email })
          .from(shopCustomers)
          .where(
            and(
              eq(shopCustomers.id, customer.id),
              eq(shopCustomers.shopId, shop.id),
              isNull(shopCustomers.archivedAt),
            ),
          )
          .for('update');
        if (!row) return false;
        if (!(await checkShopCode(tx, 'change-email', shop.id, customer.id, input.otp, newEmail))) {
          return false;
        }
        await tx
          .update(shopCustomers)
          .set({ email: newEmail, emailVerified: true, updatedAt: sql`now()` })
          .where(eq(shopCustomers.id, customer.id));
        await tx
          .delete(shopCustomerSessions)
          .where(
            and(
              eq(shopCustomerSessions.userId, customer.id),
              eq(shopCustomerSessions.shopId, shop.id),
              ne(shopCustomerSessions.id, customer.sessionId),
            ),
          );
        await recordAudit(tx, {
          action: 'shop_customer.email_changed',
          ...this.byShopCustomer(customer.id, meta),
          details: { before: { email: row.email }, after: { email: newEmail } },
        });
        await this.notifications.queueEmail(tx, {
          to: row.email,
          template: 'shop_customer_email_changed',
          params: { shopName: shop.displayName, slug: shop.slug, at: new Date().toISOString() },
        });
        return true;
      });
    } catch (error) {
      // The address was taken in the shop between the request and the confirmation.
      if (isUniqueViolation(error)) {
        throw new CodedException(409, 'EMAIL_TAKEN', 'The email belongs to another account');
      }
      throw error;
    }
    if (!changed) throw invalidCode();
  }

  /** CA1: the invitation email for a customer the merchant created, in the caller's transaction. */
  async invite(
    tx: Transaction,
    shop: { id: string; slug: string; displayName: string },
    customer: { id: string; email: string },
    meta: RequestMeta & { actorId: string },
  ): Promise<void> {
    const { token, expiresAt } = await issueInvitation(tx, customer.id);
    await this.notifications.queueEmail(tx, {
      to: customer.email,
      template: 'shop_customer_invitation',
      params: {
        shopName: shop.displayName,
        slug: shop.slug,
        token,
        expiresAt: expiresAt.toISOString(),
      },
    });
    await recordAudit(tx, {
      action: 'shop_customer.invited',
      actorKind: 'customer',
      actorId: meta.actorId,
      channel: 'store',
      entityType: 'shop_customer',
      entityId: customer.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { shopId: shop.id },
    });
  }

  /**
   * CA1: the invitation's token sets the password of an account that has none and verifies the
   * email; the caller signs the customer in. Any other token is `INVALID_OTP`.
   */
  async acceptInvitation(
    shop: ShopOfRequest,
    input: { token: string; password: string },
    meta: RequestMeta,
  ): Promise<SessionProof> {
    const passwordHash = await hashPassword(input.password);
    const proof = await this.db.transaction(async (tx) => {
      const id = await takeInvitation(tx, input.token);
      if (!id) return null;
      const [customer] = await tx
        .select({ id: shopCustomers.id, email: shopCustomers.email })
        .from(shopCustomers)
        .where(
          and(
            eq(shopCustomers.id, id),
            eq(shopCustomers.shopId, shop.id),
            isNull(shopCustomers.archivedAt),
          ),
        )
        .for('update');
      if (!customer || (await this.passwordHash(tx, customer.id))) return null;
      if (passwordEqualsEmail(input.password, customer.email)) return null;
      await tx.insert(shopCustomerAccounts).values({
        userId: customer.id,
        accountId: customer.id,
        providerId: 'credential',
        password: passwordHash,
      });
      await recordAudit(tx, {
        action: 'shop_customer.password_changed',
        ...this.byShopCustomer(customer.id, meta),
        details: { count: 0 },
      });
      await this.markVerified(tx, shop.id, customer.id, meta);
      return { shopCustomerId: customer.id, passwordHash };
    });
    if (!proof) throw invalidCode();
    return proof;
  }

  /** Whether a session may still open on a proof: the account live and the password unchanged. */
  async proofStillHolds(proof: SessionProof): Promise<boolean> {
    const [row] = await this.db
      .select({ password: shopCustomerAccounts.password })
      .from(shopCustomerAccounts)
      .innerJoin(shopCustomers, eq(shopCustomers.id, shopCustomerAccounts.userId))
      .where(
        and(
          eq(shopCustomerAccounts.userId, proof.shopCustomerId),
          eq(shopCustomerAccounts.providerId, 'credential'),
          isNull(shopCustomers.archivedAt),
        ),
      );
    return row?.password === proof.passwordHash;
  }

  private async unverified(tx: Transaction, shopId: string, email: string) {
    const [row] = await tx
      .select({ id: shopCustomers.id })
      .from(shopCustomers)
      .where(
        and(
          eq(shopCustomers.shopId, shopId),
          eq(shopCustomers.email, email),
          eq(shopCustomers.emailVerified, false),
          isNull(shopCustomers.archivedAt),
        ),
      );
    return row ?? null;
  }

  private async passwordHash(tx: Transaction, shopCustomerId: string): Promise<string | null> {
    const [account] = await tx
      .select({ password: shopCustomerAccounts.password })
      .from(shopCustomerAccounts)
      .where(
        and(
          eq(shopCustomerAccounts.userId, shopCustomerId),
          eq(shopCustomerAccounts.providerId, 'credential'),
        ),
      );
    return account?.password ?? null;
  }

  private async setPassword(
    tx: Transaction,
    shopId: string,
    shopCustomerId: string,
    passwordHash: string,
    meta: RequestMeta,
  ): Promise<void> {
    const updated = await tx
      .update(shopCustomerAccounts)
      .set({ password: passwordHash })
      .where(
        and(
          eq(shopCustomerAccounts.userId, shopCustomerId),
          eq(shopCustomerAccounts.providerId, 'credential'),
        ),
      )
      .returning({ id: shopCustomerAccounts.id });
    if (updated.length === 0) {
      await tx.insert(shopCustomerAccounts).values({
        userId: shopCustomerId,
        accountId: shopCustomerId,
        providerId: 'credential',
        password: passwordHash,
      });
    }
    const ended = await tx
      .delete(shopCustomerSessions)
      .where(
        and(
          eq(shopCustomerSessions.userId, shopCustomerId),
          eq(shopCustomerSessions.shopId, shopId),
        ),
      )
      .returning({ id: shopCustomerSessions.id });
    await recordAudit(tx, {
      action: 'shop_customer.password_changed',
      ...this.byShopCustomer(shopCustomerId, meta),
      details: { count: ended.length },
    });
  }

  private async markVerified(
    tx: Transaction,
    shopId: string,
    shopCustomerId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await tx
      .update(shopCustomers)
      .set({ emailVerified: true, updatedAt: sql`now()` })
      .where(eq(shopCustomers.id, shopCustomerId));
    await recordAudit(tx, {
      action: 'shop_customer.email_verified',
      ...this.byShopCustomer(shopCustomerId, meta),
      details: { shopId },
    });
  }

  private async queueCode(
    tx: Transaction,
    shop: ShopOfRequest,
    purpose: ShopCodePurpose,
    email: string,
  ): Promise<void> {
    const code = await issueShopCode(tx, purpose, shop.id, email);
    await this.notifications.queueEmail(tx, {
      to: email,
      template:
        purpose === 'email-verification'
          ? 'shop_customer_verify_email'
          : 'shop_customer_reset_password',
      params: { shopName: shop.displayName, slug: shop.slug, code },
    });
  }

  private byShopCustomer(id: string, meta: RequestMeta) {
    return {
      actorKind: 'shop_customer',
      actorId: id,
      channel: 'store',
      entityType: 'shop_customer',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
