import type {
  ErrorCode,
  MerchantApplication,
  MerchantApplicationEvent,
  MerchantSettings,
} from '@vertex-digital/contracts';
import { infoRequestExpiresAt } from '@vertex-digital/contracts';
import {
  CustomerError,
  type Executor,
  type MerchantApplicationRow,
  type MerchantSettingsRow,
  merchantApplicationEvents,
  OrderError,
} from '@vertex-digital/db';
import { asc, eq } from 'drizzle-orm';
import { CodedException } from '../../core/errors/index.js';

/** The HTTP status of each coded refusal of the merchant write paths (S20 "API"). */
const STATUS: Partial<Record<ErrorCode, 400 | 403 | 404 | 409 | 429>> = {
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  ACCOUNT_FROZEN: 403,
  RATE_LIMITED: 429,
};

/** A `CustomerError` or `OrderError` as the API answers it; anything else is rethrown as is. */
export function coded(error: unknown): unknown {
  if (error instanceof CustomerError || error instanceof OrderError) {
    return new CodedException(
      STATUS[error.code] ?? 409,
      error.code,
      error.message,
      error.details ?? undefined,
    );
  }
  return error;
}

export const merchantRefusals = {
  notFound: (what = 'application') => new CodedException(404, 'NOT_FOUND', `No such ${what}`),
  rateLimited: () => new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later'),
  keyReused: () =>
    new CodedException(409, 'IDEMPOTENCY_KEY_REUSED', 'The key was used for another application'),
  stateInvalid: (status: string) =>
    new CodedException(409, 'APPLICATION_STATE_INVALID', 'The application cannot move so', {
      status,
    }),
  invalid: (path: string, message: string) =>
    new CodedException(400, 'VALIDATION_FAILED', message, [{ path: [path], message }]),
};

/** The timeline of applications, oldest first, keyed by application. */
export async function applicationEvents(
  db: Executor,
  applicationId: string,
): Promise<MerchantApplicationEvent[]> {
  const rows = await db
    .select()
    .from(merchantApplicationEvents)
    .where(eq(merchantApplicationEvents.applicationId, applicationId))
    .orderBy(asc(merchantApplicationEvents.createdAt), asc(merchantApplicationEvents.id));
  return rows.map((row) => ({
    event: row.event,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** An application as its customer reads it. */
export function applicationView(
  row: MerchantApplicationRow,
  events: MerchantApplicationEvent[],
  infoExpiryDays: number,
): MerchantApplication {
  return {
    id: row.id,
    status: row.status,
    tradeName: row.tradeName,
    activity: row.activity,
    activityOther: row.activityOther,
    yearsInBusiness: row.yearsInBusiness,
    governorate: row.governorate,
    city: row.city,
    streetAddress: row.streetAddress,
    whatsapp: row.whatsapp,
    telegramUsername: row.telegramUsername,
    monthlyVolume: row.monthlyVolume,
    productInterests: row.productInterests,
    salesChannels: row.salesChannels,
    shopPhotoFileId: row.shopPhotoFileId,
    shopLink: row.shopLink,
    heardFrom: row.heardFrom,
    adminMessage: row.adminMessage,
    submittedAt: row.submittedAt.toISOString(),
    infoRequestedAt: row.infoRequestedAt?.toISOString() ?? null,
    expiresAt:
      row.status === 'info_requested' && row.infoRequestedAt
        ? infoRequestExpiresAt(row.infoRequestedAt, infoExpiryDays).toISOString()
        : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    events,
  };
}

/** The settings in force with the deposit minimum both limits must reach. */
export function settingsView(
  row: MerchantSettingsRow,
  minDepositUsdUnits: number,
): MerchantSettings {
  return {
    perDepositUsdUnits: row.perDepositUsdUnits,
    dailyDepositUsdUnits: row.dailyDepositUsdUnits,
    ordersPerTenMinutes: row.ordersPerTenMinutes,
    reapplyWaitDays: row.reapplyWaitDays,
    infoExpiryDays: row.infoExpiryDays,
    playerChecksPerHour: row.playerChecksPerHour,
    playerChecksPerDay: row.playerChecksPerDay,
    minDepositUsdUnits,
    updatedAt: row.createdAt.toISOString(),
  };
}
