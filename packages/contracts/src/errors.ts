import { z } from 'zod';

/**
 * Codes on errors the UI must tell apart (ADR 0011). The front ends show the translation of the
 * code, never the server message. A code is added with its first use.
 */
export const ERROR_CODES = [
  /** A debit would take a customer wallet below zero (ADR 0003). */
  'INSUFFICIENT_BALANCE',
  /** An idempotency key was used again for a different request or journal (ADR 0003, 0004). */
  'IDEMPOTENCY_KEY_REUSED',
  /** A malformed request the validation did not describe (bad JSON, wrong content type). */
  'BAD_REQUEST',
  /** The input failed its contract schema; the issues are in `details`. */
  'VALIDATION_FAILED',
  /** No valid session for this route. */
  'UNAUTHORIZED',
  /** Signed in, but with the wrong kind of session or no right to this record. */
  'FORBIDDEN',
  /** The admin has not enrolled TOTP yet (ADR 0007, 0016). */
  'TWO_FACTOR_REQUIRED',
  /** A customer whose email is not verified yet (ADR 0007). */
  'EMAIL_NOT_VERIFIED',
  /** A route that needs a solved ALTCHA challenge got none (ADR 0008). */
  'ALTCHA_REQUIRED',
  /** The ALTCHA solution is wrong, expired or already used (ADR 0008). */
  'ALTCHA_INVALID',
  /** A browser request from an origin other than the host's own (ADR 0007, 0008). */
  'CROSS_ORIGIN_REFUSED',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  /** Too many requests from this client; retry later (ADR 0008). */
  'RATE_LIMITED',
  /** An unexpected server error; the details are only in the logs and Sentry. */
  'INTERNAL_ERROR',
  /** Customer sign-up while registration is closed (S01 rule C16). */
  'REGISTRATION_CLOSED',
  /** A sensitive admin action without a re-authentication in the last 5 minutes (rule D5). */
  'REAUTHENTICATION_REQUIRED',
  /** The admin signed in with a CLI-issued password and must change it first (rule D1). */
  'PASSWORD_CHANGE_REQUIRED',
  /** The email belongs to another account (admin routes and races only: rules T3, C12). */
  'EMAIL_TAKEN',
  /** The new password is in the common-password list (rules C3, D6). */
  'PASSWORD_TOO_COMMON',
  /** The admin session ended after 30 minutes without activity (rule D4). */
  'SESSION_IDLE_EXPIRED',
  /** A wrong current password on a change or a re-authentication (rules C11, C12, D5, D7). */
  'INVALID_PASSWORD',
  /** A wrong authenticator code on a re-authentication (rule D5). */
  'INVALID_CODE',
  /** A wrong or unknown email code (rule C4). */
  'INVALID_OTP',
  /** The email code expired: request a new one (rule C4). */
  'OTP_EXPIRED',
  /** A right email code for an account holding another password: set one by "forgot password" (rule C7, F2-7). */
  'PASSWORD_MISMATCH',
  /** Five wrong tries voided the email code: request a new one (rule C4). */
  'TOO_MANY_ATTEMPTS',
  /** Test funds for a customer who is not a test customer (S02 rule J4). */
  'ADJUSTMENT_NOT_ALLOWED',
  /** An adjustment above $100 without the amount typed a second time (rule J6). */
  'AMOUNT_CONFIRMATION_REQUIRED',
  /** The amount typed a second time differs from the amount (rule J6). */
  'AMOUNT_CONFIRMATION_MISMATCH',
  /** The Sham Cash transaction number or TXID is already recorded (rule J8). */
  'EXTERNAL_REFERENCE_TAKEN',
  /** The adjustment was already reversed (rule R2). */
  'ADJUSTMENT_ALREADY_REVERSED',
  /** A reversal cannot itself be reversed (rule R3). */
  'ADJUSTMENT_NOT_REVERSIBLE',
  /** A rate change above 5% without the rate typed a second time (S03 rule FX2). */
  'RATE_CONFIRMATION_REQUIRED',
  /** The rate typed a second time differs from the new rate (S03 rule FX2). */
  'RATE_CONFIRMATION_MISMATCH',
  /** No exchange rate exists yet: SYP deposits are unavailable (S03 rule FX8). */
  'RATE_UNAVAILABLE',
  /** A SYP deposit's 15-minute quote expired, or the rate seen is not the quote's (rule SC9). */
  'QUOTE_EXPIRED',
  /** The deposit method or currency is not available now (rule SC1). */
  'DEPOSIT_METHOD_UNAVAILABLE',
  /** Below the minimum, above the per-deposit limit, or beyond the daily limit (rule SC3). */
  'DEPOSIT_LIMIT_EXCEEDED',
  /** The customer already has a deposit awaiting a receipt; `details.depositId` (rule SC4). */
  'DEPOSIT_ALREADY_PENDING',
  /** Three deposits are already under review (rule SC5). */
  'TOO_MANY_DEPOSITS_IN_REVIEW',
  /** The deposit's status does not allow this change; `details.status` (S03 "Deposit states"). */
  'DEPOSIT_STATE_CONFLICT',
  /** The credit an approval would post is not the one the panel showed: the rate moved (F4-4). */
  'DEPOSIT_CREDIT_CHANGED',
  /** The upload is not a decodable JPEG, PNG or WebP image (rule SC8). */
  'RECEIPT_INVALID',
  /** The approval did not acknowledge exactly the deposit's flags (rule RV5). */
  'FLAGS_NOT_ACKNOWLEDGED',
  /** A clearer receipt was already asked for once on this deposit (rule RV8). */
  'RECEIPT_ALREADY_REQUESTED',
  /** Not a TXID, a `0x` hash or a Tronscan / BscScan transaction link (S04 rule U8). */
  'TXID_INVALID',
  /** Five TXIDs were already submitted for this deposit (S04 rule U8). */
  'TXID_ATTEMPTS_EXCEEDED',
  /** Every tail of this amount is reserved on this network: try a cent more or less (rule U3). */
  'DEPOSIT_AMOUNT_BUSY',
  /** New deposits of this method are stopped; `details.reason`: `emergency` or `method_paused` (S05 rule SW4). */
  'DEPOSITS_STOPPED',
  /** The bot's username or webhook secret is not set on the server (S05 rule TG1). */
  'TELEGRAM_NOT_CONFIGURED',
  /** The slug is used by another row, archived ones included: URLs are never reused (S06). */
  'SLUG_TAKEN',
  /** An unarchived sibling already has this name (S06 rule CT1). */
  'NAME_TAKEN',
  /** The game already has a field with this key, archived ones included (S06 rule CT7). */
  'FIELD_KEY_TAKEN',
  /** The game cannot be active without these; `details.missing`: `cover`, `input_fields` (rule CT3). */
  'CATALOG_INCOMPLETE',
  /** The category still has unarchived games (S06 rule CT2). */
  'CATALOG_NOT_EMPTY',
  /** The parent (category or game) is archived (S06 rule CT1). */
  'PARENT_ARCHIVED',
  /** The accent is below 3:1 against the dark surface; `details.ratio` (S06 rule CT6). */
  'ACCENT_CONTRAST_TOO_LOW',
  /** The upload is not a decodable PNG, JPEG or WebP image within the limits (S06 rule CT10). */
  'IMAGE_INVALID',
  /** A game holds at most 10 input fields and 100 products (S06). */
  'CATALOG_LIMIT_REACHED',
  /** The global margin rule cannot be archived (S06 rule PR2). */
  'GLOBAL_RULE_REQUIRED',
  /** The supplier needs credentials first (S07 rule SP1). */
  'SUPPLIER_NOT_CONFIGURED',
  /** This build has no adapter for the supplier, or it lists no offers (S07 rule SP1). */
  'SUPPLIER_UNAVAILABLE',
  /** The offer already serves another product; `details.productId`, `details.productNameAr` (rule RT1). */
  'OFFER_ALREADY_MAPPED',
  /** The route's expected delivery time is not below its hard limit (S17). */
  'ROUTE_TIMING_INVALID',
  /** The offer's kind is not the product's (rule RT2). */
  'ROUTE_KIND_MISMATCH',
  /** The supplier fields left unmapped; `details.fields` (rule RT3). */
  'ROUTE_FIELDS_UNMAPPED',
  /** The offer is no longer listed by its supplier (S07 edge case 5). */
  'OFFER_MISSING',
  /** The review was already decided (rule P4). */
  'REVIEW_CLOSED',
  /** The proposed price changed since it was shown; `details.proposedPriceUsdUnits` (rule P4). */
  'REVIEW_STALE',
  /** The display step adds more than 2% to the cheapest product; `details.maxStepSypUnits` (rule P9). */
  'DISPLAY_STEP_TOO_LARGE',
  /** The purchase stop is on (S05 SW5, S08 rule O2). */
  'PURCHASES_STOPPED',
  /** The product cannot be bought now; `details.availability` (S08 rule O3). */
  'PRODUCT_UNAVAILABLE',
  /** The price is not the one the customer saw; `details.unitPriceUsdUnits` (S08 rule O4). */
  'PRICE_CHANGED',
  /** The order is not in a state the admin can decide on (S08 rule D1). */
  'ORDER_NOT_DECIDABLE',
  /** The attempt is closed, or not one the admin can resolve or poll (S08 rule D1). */
  'ATTEMPT_NOT_RESOLVABLE',
  /** A code product needs exactly one code per unit delivered (S08 rule D2). */
  'CODES_COUNT_MISMATCH',
  /** A supplier webhook's signature or timestamp is wrong (S08 rule F4). */
  'WEBHOOK_SIGNATURE_INVALID',
  /** The player id is not known valid and the customer did not confirm it (S09 rule PV8). */
  'PLAYER_NOT_CONFIRMED',
  /** The checked account's region is not one the game's packs serve; `details.region` (S19 PC3). */
  'PLAYER_REGION_MISMATCH',
  /** The customer already holds the most open reservations; `details.limit` (S09 rule RS2). */
  'RESERVATIONS_LIMIT_REACHED',
  /** Only a reservation can be cancelled; `details.status` (S09 rule RS8). */
  'ORDER_NOT_CANCELLABLE',
  /** A cart was refused as a whole; `details.lines: [{ index, code, details }]` (S10 rule CT5). */
  'CHECKOUT_REFUSED',
  /** No share link for this order; `details.reason`: `status`, `not_gift`, `link_exists` (S10). */
  'ORDER_NOT_SHAREABLE',
  /** The chosen route cannot take the order now; `details.reason`: a route skip reason (S11 RR3). */
  'ROUTE_NOT_ELIGIBLE',
  /** The cost is above the price and the loss was not confirmed; `details.unitCostUsdUnits`, `details.unitPriceUsdUnits` (S11 MF4). */
  'LOSS_NOT_CONFIRMED',
  /** The delivery proof is missing, of another kind, or already used (S11 MF2). */
  'PROOF_INVALID',
  /** The customer is frozen: no new deposit, purchase, reservation or player check (S12 CF2). */
  'ACCOUNT_FROZEN',
  /** Beyond the customer's daily purchase cap; `details.limitUnits`, `details.remainingUnits` (S12 LM4). */
  'PURCHASE_LIMIT_EXCEEDED',
  /** The customer's status does not allow this change; `details.status` (S12 CF1, CF6, AR1, AR3, LM5, TK10). */
  'CUSTOMER_STATE_INVALID',
  /** Archiving needs a zero balance and nothing open; `details.blockers` (S12 AR1). */
  'CUSTOMER_NOT_ARCHIVABLE',
  /** Too many tickets; `details.limit`: `open` or `daily` (S12 TK1, TK4). */
  'TICKETS_LIMIT_REACHED',
  /** The order or deposit already has a ticket that is not closed; `details.ticketId` (S12 TK1, TK4). */
  'TICKET_ALREADY_OPEN',
  /** The ticket closed more than 7 days ago: open a new one (S12 TK4). */
  'TICKET_CLOSED',
  /** The ticket's order or deposit is missing for its type, given for another, or not the customer's (S12 TK1). */
  'TICKET_LINK_INVALID',
  /** A reconciliation run is already running (S13 RN2, RN6). */
  'RECONCILIATION_RUNNING',
  /** Only the newest result of its check and subject, a mismatch not yet explained (S13 RN8). */
  'RESULT_NOT_EXPLAINABLE',
  /** The same place twice, or outside to outside (S13 T2). */
  'TREASURY_PLACES_INVALID',
  /** More received than sent in one currency (S13 T3). */
  'MOVEMENT_RECEIVED_EXCEEDS_SENT',
  /** The place already has a movement: an opening balance comes first (S13 T6). */
  'OPENING_BALANCE_EXISTS',
  /** The movement was already reversed (S13 T9). */
  'MOVEMENT_ALREADY_REVERSED',
  /** A reversal cannot itself be reversed (S13 T9). */
  'MOVEMENT_NOT_REVERSIBLE',
  /** The report period ends before it starts or is longer than 366 days (S13 RP1). */
  'REPORT_PERIOD_INVALID',
  /** The draft or the FAQ changed since it was read: reload (S14 PG3, PG5, FQ6). */
  'CONTENT_STALE',
  /** Nothing to publish: the newest version or publication is already this (S14 PG5, FQ6). */
  'CONTENT_UNCHANGED',
  /** Too many FAQ sections or questions, banners or announcements (S14 FQ2, BN3, AN2). */
  'CONTENT_LIMIT_REACHED',
  /** The API has no VAPID public key: push is off in this environment (S15). */
  'PUSH_NOT_CONFIGURED',
  /** The endpoint is not `https:` on an allowed push service (S15 PS2). */
  'PUSH_ENDPOINT_REFUSED',
  /** Beyond today's owner cap for owner-funded admin orders; `details.remainingUsdUnits` (S16 AP7). */
  'OWNER_DAILY_CAP_EXCEEDED',
  /** The offer has fields its adapter cannot send (S16 SC3, MF1, MF2). */
  'OFFER_UNSUPPORTED',
  /**
   * A select field's options have no supplier value in the offer's list (S16 MF3); per row in
   * `details.rows`, or `details.fields` (the supplier keys) on a route.
   */
  'FIELD_OPTIONS_DIFFER',
  /** The offer is ignored: unignore it first (S16 SC6). */
  'OFFER_IGNORED',
  /** The category, an ancestor or a descendant is linked to another game; `details.gameId` (S16 SC7). */
  'CATEGORY_LINKED',
  /** The supplier no longer lists the category (S16 SC7). */
  'CATEGORY_MISSING',
  /** The supplier's image could not be downloaded or decoded: upload one instead (S16 IM2). */
  'IMAGE_FETCH_FAILED',
  /** The supplier's adapter cannot do this (categories, statement, platform status; S16). */
  'CAPABILITY_UNSUPPORTED',
  /** S19 FC8: the store has no public HTTPS address for a supplier's webhook (`STORE_URL`). */
  'STORE_URL_NOT_PUBLIC',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The body of every error the API answers (ADR 0011). */
export const errorResponseSchema = z
  .object({
    statusCode: z.int().min(400).max(599),
    code: errorCodeSchema,
    /** English, for logs; the UI shows the translation of `code`. */
    message: z.string(),
    /** Machine-readable extras, such as the validation issues. */
    details: z.unknown().optional(),
  })
  .meta({ id: 'ErrorResponse' });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
