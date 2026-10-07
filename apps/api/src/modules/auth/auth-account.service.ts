import { Inject, Injectable } from '@nestjs/common';
import {
  type ChangePassword,
  type CustomerProfile,
  describeUserAgent,
  PASSWORD_EQUALS_EMAIL,
  passwordEqualsEmail,
} from '@vertex-digital/contracts';
import {
  customerAccounts,
  customerSessions,
  customers,
  type Database,
  newId,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { NotificationsService } from '../notifications/index.js';
import { type CodeCheck, checkCode, issueCode, issueDecoyCode } from './email-codes.js';
import { type Limit, withinLimits } from './rate-counter.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Code sends (rule C5): per email 1 a minute, 5 an hour, 10 a day; per address 20 an hour. */
const codeLimits = (email: string, ip: string | null): Limit[] => [
  { key: `code-email-minute:${email}`, max: 1, windowMs: MINUTE },
  { key: `code-email-hour:${email}`, max: 5, windowMs: HOUR },
  { key: `code-email-day:${email}`, max: 10, windowMs: DAY },
  { key: `code-ip-hour:${ip ?? 'unknown'}`, max: 20, windowMs: HOUR },
];

/** Sign-ups per address (S01 "Abuse and fraud"): 5 an hour. */
const signUpLimit = (ip: string | null): Limit => ({
  key: `sign-up-ip-hour:${ip ?? 'unknown'}`,
  max: 5,
  windowMs: HOUR,
});

/** The attempt notice goes to an address at most once an hour (rules C2, C12). */
const attemptNoticeLimit = (email: string): Limit => ({
  key: `attempt-notice-hour:${email}`,
  max: 1,
  windowMs: HOUR,
});

const rateLimited = () => new CodedException(429, 'RATE_LIMITED', 'Too many codes, try later');

const codeError = (check: Exclude<CodeCheck, { ok: true }>) =>
  new CodedException(400, check.code, 'The code is not valid');

const passwordEqualsEmailError = (field: string) =>
  new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
    { path: [field], message: PASSWORD_EQUALS_EMAIL },
  ]);

/** The signed-in customer as the account routes see them. */
export interface AccountHolder {
  id: string;
  email: string;
  sessionId: string;
}

/**
 * Customer account changes (S01 rules C1–C15): each change, its audit entry and its emails are
 * written in one transaction. Better Auth keeps the sign-in, the session cookie and the session
 * reads; everything that changes an account goes through here.
 */
@Injectable()
export class AuthAccountService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly notifications: NotificationsService,
  ) {}

  /** Rule C1, C2, C16: the same answer whether or not the email has an account. */
  async signUp(
    input: { name: string; email: string; password: string; phone: string },
    meta: RequestMeta,
  ): Promise<void> {
    if (!this.env.REGISTRATION_OPEN) {
      throw new CodedException(403, 'REGISTRATION_CLOSED', 'Registration is closed');
    }
    const email = input.email.trim().toLowerCase();
    if (!(await withinLimits(this.db, [signUpLimit(meta.ipAddress)]))) throw rateLimited();
    if (!(await withinLimits(this.db, codeLimits(email, meta.ipAddress)))) throw rateLimited();
    // Hashed on both paths, so the time taken does not tell whether the email has an account.
    const passwordHash = await hashPassword(input.password);
    const [existing] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email));
    if (existing) {
      await this.db.transaction((tx) => issueDecoyCode(tx, 'email-verification', email));
      await this.sendAttemptNotice(email, existing.id);
      return;
    }
    const id = newId();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(customers).values({ id, name: input.name, email, phone: input.phone });
        await tx.insert(customerAccounts).values({
          userId: id,
          accountId: id,
          providerId: 'credential',
          password: passwordHash,
        });
        await recordAudit(tx, {
          action: 'customer.signed_up',
          ...this.byCustomer(id, meta),
          details: { name: input.name, email, phone: input.phone },
        });
        await this.queueCode(tx, 'email-verification', email, id);
      });
    } catch (error) {
      // A sign-up with the same email won the race: answer as for an existing account.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Rule C4, C5: a new verification code for an unverified account; silent otherwise. */
  async sendVerificationCode(emailInput: string, meta: RequestMeta): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    if (!(await withinLimits(this.db, codeLimits(email, meta.ipAddress)))) throw rateLimited();
    await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.email, email),
            eq(customers.emailVerified, false),
            isNull(customers.archivedAt),
          ),
        );
      if (customer) await this.queueCode(tx, 'email-verification', email, customer.id);
      else await issueDecoyCode(tx, 'email-verification', email);
    });
  }

  /** The code Better Auth asks for when an unverified customer signs in, within the limits. */
  async sendVerificationCodeOnSignIn(email: string, meta: RequestMeta): Promise<void> {
    await this.sendVerificationCode(email, meta).catch((error: unknown) => {
      // Over the limit: the sign-in still answers EMAIL_NOT_VERIFIED, with no new code.
      if (!(error instanceof CodedException && error.code === 'RATE_LIMITED')) throw error;
    });
  }

  /** Rule C7: the code verifies the email; the caller signs the customer in. */
  async verifyEmail(emailInput: string, otp: string, meta: RequestMeta): Promise<string> {
    const email = emailInput.trim().toLowerCase();
    const outcome = await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id, emailVerified: customers.emailVerified })
        .from(customers)
        .where(and(eq(customers.email, email), isNull(customers.archivedAt)))
        .for('update');
      // The code first: its answers are the same whether or not the email has an account.
      const check = await checkCode(tx, 'email-verification', email, otp);
      if (!check.ok) return check;
      if (!customer) return { ok: false, code: 'INVALID_OTP' } as const;
      await this.markVerified(tx, customer, email, meta);
      return { ok: true, id: customer.id } as const;
    });
    if (!outcome.ok) throw codeError(outcome);
    return outcome.id;
  }

  /** Rule C5, C7: a password-reset code for an existing account; silent otherwise. */
  async requestPasswordReset(emailInput: string, meta: RequestMeta): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    if (!(await withinLimits(this.db, codeLimits(email, meta.ipAddress)))) throw rateLimited();
    await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.email, email), isNull(customers.archivedAt)));
      if (customer) await this.queueCode(tx, 'forget-password', email, customer.id);
      else await issueDecoyCode(tx, 'forget-password', email);
    });
  }

  /** Rule C7: sets the password, verifies the email and signs out every session. */
  async resetPassword(
    input: { email: string; otp: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const outcome = await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id, emailVerified: customers.emailVerified })
        .from(customers)
        .where(and(eq(customers.email, email), isNull(customers.archivedAt)))
        .for('update');
      const check = await checkCode(tx, 'forget-password', email, input.otp);
      if (!check.ok) return check;
      if (!customer) return { ok: false, code: 'INVALID_OTP' } as const;
      await this.setPassword(tx, customer.id, passwordHash);
      await this.markVerified(tx, customer, email, meta);
      await tx.delete(customerSessions).where(eq(customerSessions.userId, customer.id));
      await recordAudit(tx, {
        action: 'customer.password_reset',
        ...this.byCustomer(customer.id, meta),
        details: {},
      });
      await this.notifications.queueEmail(tx, {
        to: email,
        template: 'customer_password_changed',
        params: { at: new Date().toISOString() },
        customerId: customer.id,
      });
      return { ok: true } as const;
    });
    if (!outcome.ok) throw codeError(outcome);
  }

  /** Rule C11: needs the current password; every other session is signed out. */
  async changePassword(holder: AccountHolder, input: ChangePassword, meta: RequestMeta) {
    await this.assertPassword(holder.id, input.currentPassword);
    if (passwordEqualsEmail(input.newPassword, holder.email)) {
      throw passwordEqualsEmailError('newPassword');
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await this.setPassword(tx, holder.id, passwordHash);
      const others = await this.signOutOthers(tx, holder);
      await recordAudit(tx, {
        action: 'customer.password_changed',
        ...this.byCustomer(holder.id, meta),
        details: { count: others },
      });
      await this.notifications.queueEmail(tx, {
        to: holder.email,
        template: 'customer_password_changed',
        params: { at: new Date().toISOString() },
        customerId: holder.id,
      });
    });
  }

  /**
   * Rule C12: a code to the new address, or, when it belongs to another account, the same answer
   * with an attempt notice to it instead.
   */
  async requestEmailChange(
    holder: AccountHolder,
    input: { newEmail: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    await this.assertPassword(holder.id, input.password);
    const newEmail = input.newEmail.trim().toLowerCase();
    if (newEmail === holder.email) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
        { path: ['newEmail'], message: 'Same as the current email' },
      ]);
    }
    if (!(await withinLimits(this.db, codeLimits(newEmail, meta.ipAddress)))) {
      throw rateLimited();
    }
    const [taken] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, newEmail));
    if (taken) {
      // A code nobody receives replaces any earlier one, as a real request would.
      await this.db.transaction((tx) => issueDecoyCode(tx, 'change-email', holder.id));
      await this.sendAttemptNotice(newEmail, taken.id);
      return;
    }
    await this.db.transaction(async (tx) => {
      // One pending change per customer: a new request voids the code of an earlier address.
      const code = await issueCode(tx, 'change-email', holder.id, newEmail);
      await this.notifications.queueEmail(tx, {
        to: newEmail,
        template: 'customer_change_email',
        params: { code },
        customerId: holder.id,
      });
    });
  }

  /** Rule C12: the code changes the email, signs out the other sessions, tells the old address. */
  async confirmEmailChange(
    holder: AccountHolder,
    input: { newEmail: string; otp: string },
    meta: RequestMeta,
  ): Promise<void> {
    const newEmail = input.newEmail.trim().toLowerCase();
    let outcome: CodeCheck;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const check = await checkCode(tx, 'change-email', holder.id, input.otp, newEmail);
        if (!check.ok) return check;
        await tx
          .update(customers)
          .set({ email: newEmail, emailVerified: true })
          .where(eq(customers.id, holder.id));
        await this.signOutOthers(tx, holder);
        await recordAudit(tx, {
          action: 'customer.email_changed',
          ...this.byCustomer(holder.id, meta),
          details: { before: { email: holder.email }, after: { email: newEmail } },
        });
        await this.notifications.queueEmail(tx, {
          to: holder.email,
          template: 'customer_email_changed',
          params: { at: new Date().toISOString() },
          customerId: holder.id,
        });
        return check;
      });
    } catch (error) {
      // Edge case 8: the address was taken between the request and the confirmation.
      if (isUniqueViolation(error)) {
        throw new CodedException(409, 'EMAIL_TAKEN', 'The email belongs to another account');
      }
      throw error;
    }
    if (!outcome.ok) throw codeError(outcome);
  }

  /** Rule C14: one of the customer's own sessions, by its token; another's answers 404. */
  async revokeSession(holder: AccountHolder, token: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(customerSessions)
        .where(and(eq(customerSessions.token, token), eq(customerSessions.userId, holder.id)))
        .returning({ id: customerSessions.id });
      if (removed.length === 0) throw new CodedException(404, 'NOT_FOUND', 'No such session');
      await recordAudit(tx, {
        action: 'customer.sessions_revoked',
        ...this.byCustomer(holder.id, meta),
        details: { count: removed.length },
      });
    });
  }

  /** Rule C14: "sign out everywhere", the current session included. */
  async revokeAllSessions(holder: AccountHolder, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(customerSessions)
        .where(eq(customerSessions.userId, holder.id))
        .returning({ id: customerSessions.id });
      await recordAudit(tx, {
        action: 'customer.sessions_revoked',
        ...this.byCustomer(holder.id, meta),
        details: { count: removed.length },
      });
    });
  }

  async profile(customerId: string): Promise<CustomerProfile> {
    const [customer] = await this.db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    return { ...customer, createdAt: customer.createdAt.toISOString() };
  }

  /** Rule C13: name and phone, audited with before and after of what changed. */
  async updateProfile(
    customerId: string,
    input: { name?: string; phone?: string },
    meta: RequestMeta,
  ): Promise<CustomerProfile> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ name: customers.name, phone: customers.phone })
        .from(customers)
        .where(eq(customers.id, customerId))
        .for('update');
      if (!current) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
      const before: { name?: string; phone?: string } = {};
      const after: { name?: string; phone?: string } = {};
      for (const field of ['name', 'phone'] as const) {
        const value = input[field];
        if (value !== undefined && value !== current[field]) {
          before[field] = current[field];
          after[field] = value;
        }
      }
      if (Object.keys(after).length === 0) return;
      await tx.update(customers).set(after).where(eq(customers.id, customerId));
      await recordAudit(tx, {
        action: 'customer.profile_updated',
        ...this.byCustomer(customerId, meta),
        details: { before, after },
      });
    });
    return this.profile(customerId);
  }

  /** Rule C10: the new sign-in email, with the device and address Better Auth recorded. */
  async sendSignInNotice(
    customer: { id: string; email: string },
    session: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const device = describeUserAgent(session.userAgent);
    await this.db.transaction((tx) =>
      this.notifications.queueEmail(tx, {
        to: customer.email,
        template: 'customer_new_sign_in',
        params: {
          at: new Date().toISOString(),
          browser: device.browser,
          system: device.system,
          ipAddress: session.ipAddress ?? null,
        },
        customerId: customer.id,
      }),
    );
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

  private async queueCode(
    tx: Transaction,
    purpose: 'email-verification' | 'forget-password',
    email: string,
    customerId: string,
  ): Promise<void> {
    const code = await issueCode(tx, purpose, email);
    await this.notifications.queueEmail(tx, {
      to: email,
      template:
        purpose === 'email-verification' ? 'customer_verify_email' : 'customer_reset_password',
      params: { code },
      customerId,
    });
  }

  private async sendAttemptNotice(email: string, customerId: string): Promise<void> {
    if (!(await withinLimits(this.db, [attemptNoticeLimit(email)]))) return;
    await this.db.transaction((tx) =>
      this.notifications.queueEmail(tx, {
        to: email,
        template: 'customer_sign_up_attempt',
        params: {},
        customerId,
      }),
    );
  }

  private async markVerified(
    tx: Transaction,
    customer: { id: string; emailVerified: boolean },
    email: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (customer.emailVerified) return;
    await tx.update(customers).set({ emailVerified: true }).where(eq(customers.id, customer.id));
    await recordAudit(tx, {
      action: 'customer.email_verified',
      ...this.byCustomer(customer.id, meta),
      details: { email },
    });
  }

  private async setPassword(tx: Transaction, customerId: string, passwordHash: string) {
    const updated = await tx
      .update(customerAccounts)
      .set({ password: passwordHash })
      .where(
        and(eq(customerAccounts.userId, customerId), eq(customerAccounts.providerId, 'credential')),
      )
      .returning({ id: customerAccounts.id });
    if (updated.length === 0) {
      await tx.insert(customerAccounts).values({
        userId: customerId,
        accountId: customerId,
        providerId: 'credential',
        password: passwordHash,
      });
    }
  }

  private async signOutOthers(tx: Transaction, holder: AccountHolder): Promise<number> {
    const removed = await tx
      .delete(customerSessions)
      .where(and(eq(customerSessions.userId, holder.id), ne(customerSessions.id, holder.sessionId)))
      .returning({ id: customerSessions.id });
    return removed.length;
  }

  private async assertPassword(customerId: string, password: string): Promise<void> {
    const [account] = await this.db
      .select({ password: customerAccounts.password })
      .from(customerAccounts)
      .where(
        and(eq(customerAccounts.userId, customerId), eq(customerAccounts.providerId, 'credential')),
      );
    const valid = account?.password
      ? await verifyPassword({ hash: account.password, password })
      : false;
    if (!valid) throw new CodedException(400, 'INVALID_PASSWORD', 'The password is wrong');
  }
}
