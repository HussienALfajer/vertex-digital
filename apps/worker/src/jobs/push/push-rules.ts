import { createHash } from 'node:crypto';
import type { PushNotificationEvent } from '@vertex-digital/contracts';
import type { PushResponse } from '../../push/push-sender.js';

/** Nothing is pushed for a notification older than this (PD2); TTL is what is left of it (PD3). */
export const PUSH_MAX_AGE_SECONDS = 24 * 60 * 60;

/** The retries of transient failures (PD5): 60 seconds, then 5 minutes; then dropped. */
export const PUSH_RETRY_DELAYS_SECONDS = [60, 5 * 60] as const;

/** Consecutive transient failures that delete a device (PD5). */
export const PUSH_FAILURES_MAX = 20;

/** Sends to one customer's devices run 5 at a time (PD3). */
export const PUSH_CONCURRENCY = 5;

/**
 * PD4: `delivered` (201, 202), `gone` (404, 410, or keys no payload can be encrypted for: delete
 * the row), `refused` (400, 403, 413: a
 * bug or a key mismatch; the row stays and Sentry hears once per job), or `transient` (429, 5xx,
 * a timeout or a network error, and any other answer: counted and retried).
 */
export type PushOutcome = 'delivered' | 'gone' | 'refused' | 'transient';

export function pushOutcome(response: PushResponse): PushOutcome {
  if ('error' in response) return response.error === 'invalid_subscription' ? 'gone' : 'transient';
  if (response.status === 201 || response.status === 202) return 'delivered';
  if (response.status === 404 || response.status === 410) return 'gone';
  if ([400, 403, 413].includes(response.status)) return 'refused';
  return 'transient';
}

/** PD3: 24 hours minus the notification's age, in whole seconds, never below 0. */
export function pushTtlSeconds(createdAt: Date, now: Date): number {
  const age = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
  return Math.max(0, PUSH_MAX_AGE_SECONDS - age);
}

/** PD3: order and deposit events are urgent; the balance, a cart's summary and a reply are not. */
export function pushUrgency(event: PushNotificationEvent): 'high' | 'normal' {
  return event === 'wallet_adjusted' || event === 'checkout_finished' || event === 'ticket_replied'
    ? 'normal'
    : 'high';
}

/**
 * PD3: the `Topic` header for a tag (PT3), so a push service replaces an undelivered older
 * message of the same record. RFC 8030 allows at most 32 base64url characters, fewer than a tag
 * with a uuid: the first 32 characters of the tag's SHA-256 in base64url.
 */
export function pushTopic(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}
