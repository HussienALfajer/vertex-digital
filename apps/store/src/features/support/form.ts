import {
  TICKET_LIMITS,
  type TicketCategory,
  ticketBodySchema,
  ticketSubjectSchema,
} from '@vertex-digital/contracts';
import type { Failure } from '@/lib/api';

/*
 * The checks a ticket or a message passes before it is sent (S12 TK1, TK7, TK11), with the
 * contracts' own schemas: the API checks them again.
 */

/** What the API decodes (TK11), as for a receipt. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Why a file cannot be attached, before it is sent; null when it can. */
export function imageProblem(file: { type: string; size: number }): 'invalid' | 'tooLarge' | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'invalid';
  if (file.size > TICKET_LIMITS.imageMaxBytes) return 'tooLarge';
  return null;
}

/** The longest message, for the counter. */
export const BODY_MAX = 2000;

export type TicketDraft = {
  category: TicketCategory | null;
  orderId: string | null;
  depositId: string | null;
  subject: string;
  body: string;
};

export type DraftProblem = 'category' | 'order' | 'deposit' | 'subject' | 'body';

/**
 * Rule TK7: a message with images only still needs a body; the store sends `fallback` ("صورة
 * مرفقة") when the text is empty and images are attached.
 */
export function messageBody(text: string, imageCount: number, fallback: string): string {
  return text.trim() === '' && imageCount > 0 ? fallback : text;
}

/** The fields of a new ticket that do not pass, in the form's order (TK1). */
export function draftProblems(draft: TicketDraft, imageCount: number): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.category) problems.push('category');
  if (draft.category === 'order' && !draft.orderId) problems.push('order');
  if (draft.category === 'deposit' && !draft.depositId) problems.push('deposit');
  if (!ticketSubjectSchema.safeParse(draft.subject).success) problems.push('subject');
  if (!bodyValid(draft.body, imageCount)) problems.push('body');
  return problems;
}

/** A message's text passes TK7 (with the fallback when only images are sent). */
export function bodyValid(text: string, imageCount: number): boolean {
  return ticketBodySchema.safeParse(messageBody(text, imageCount, '-')).success;
}

/** The length the counter shows, as the API counts it (new lines as one, trimmed). */
export function bodyLength(text: string): number {
  return text.replace(/\r\n?/g, '\n').trim().length;
}

/**
 * The attempt's identity: the same fields and the same files keep the same `Idempotency-Key`, so
 * a retry after a lost answer returns the first ticket or message instead of a second one.
 */
export function attemptSignature(
  fields: Record<string, string | null>,
  files: { name: string; size: number; lastModified: number }[],
): string {
  return JSON.stringify([fields, files.map((file) => [file.name, file.size, file.lastModified])]);
}

/** The session-storage slot of a new ticket's attempt (`purchase/attempt.ts`, audit A07-39). */
export const TICKET_SLOT = 'support-ticket';

/** The slot of a reply's attempt: one per ticket. */
export function replySlot(ticketId: string): string {
  return `support-reply:${ticketId}`;
}

/**
 * Whether a refusal frees the attempt's key. Only `IDEMPOTENCY_KEY_REUSED`: the key's first
 * ticket or message was written and the customer is told to look at their tickets, so what is
 * sent next is a new one. Any other refusal keeps the key: the same body sends it again, and
 * after a lost answer or a server fault an edited body does too (the shared rule, F6-14).
 */
export function freesSupportKey(reason: Failure): boolean {
  return reason === 'IDEMPOTENCY_KEY_REUSED';
}
