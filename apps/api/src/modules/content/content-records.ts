import {
  type Announcement,
  type AuditAction,
  type AuditDetails,
  type AuditEntityType,
  announcementState,
  type Banner,
  bannerState,
  type ContentPage,
  type FaqItem,
  type FaqSection,
  type RichTextProblem,
} from '@vertex-digital/contracts';
import {
  type announcements,
  type banners,
  contentSettings,
  type faqItems,
  type faqSections,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';

/*
 * Shared by the content services (S14): rows to responses, refusals with their codes, the audit
 * entry of a change and the FAQ's working revision.
 */

export type BannerRow = typeof banners.$inferSelect;
export type AnnouncementRow = typeof announcements.$inferSelect;
export type FaqSectionRow = typeof faqSections.$inferSelect;
export type FaqItemRow = typeof faqItems.$inferSelect;

/** Who changes the content: the admin, from the panel. */
export interface Actor {
  adminId: string;
  meta: RequestMeta;
}

/** The audit entity of rows keyed by something other than a UUID: fixed ids. */
export const PAGE_ENTITY_IDS: Record<ContentPage, string> = {
  terms: '00000000-0000-7000-8000-0000000c0001',
  privacy: '00000000-0000-7000-8000-0000000c0002',
  refund: '00000000-0000-7000-8000-0000000c0003',
  about: '00000000-0000-7000-8000-0000000c0004',
  merchant_terms: '00000000-0000-7000-8000-0000000c0005',
};
export const FAQ_ENTITY_ID = '00000000-0000-7000-8000-0000000c0010';
export const SETTINGS_ENTITY_ID = '00000000-0000-7000-8000-0000000c0020';

export async function audit<Action extends AuditAction>(
  tx: Transaction,
  actor: Actor,
  action: Action,
  entity: { type: AuditEntityType; id: string },
  details: AuditDetails<Action>,
): Promise<void> {
  await recordAudit(tx, {
    actorKind: 'admin',
    actorId: actor.adminId,
    channel: 'admin',
    action,
    entityType: entity.type,
    entityId: entity.id,
    details,
    ipAddress: actor.meta.ipAddress,
    userAgent: actor.meta.userAgent,
  });
}

export const refusals = {
  notFound: (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`),
  stale: () =>
    new CodedException(409, 'CONTENT_STALE', 'The content changed since it was read: reload'),
  unchanged: () =>
    new CodedException(409, 'CONTENT_UNCHANGED', 'The newest publication is already this'),
  limit: (limit: number) =>
    new CodedException(409, 'CONTENT_LIMIT_REACHED', `At most ${limit} of these`, { limit }),
  parentArchived: () =>
    new CodedException(409, 'PARENT_ARCHIVED', 'The section of this question is archived'),
  invalid: (path: (string | number)[], message: string) =>
    new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [{ path, message }]),
  /** Rule MD2: each problem at `[field, line]`, as the contract's schema reports them. */
  richText: (field: string, problems: RichTextProblem[]) =>
    new CodedException(
      400,
      'VALIDATION_FAILED',
      'Invalid input',
      problems.map((problem) => ({ path: [field, problem.line], message: problem.reason })),
    ),
};

/** Rule FQ6: every FAQ change increments the working revision, which also serializes them. */
export async function bumpFaqRevision(tx: Transaction): Promise<number> {
  const [row] = await tx
    .update(contentSettings)
    .set({ faqRevision: sql`${contentSettings.faqRevision} + 1`, updatedAt: sql`now()` })
    .returning({ revision: contentSettings.faqRevision });
  return row?.revision as number;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

const record = (row: {
  id: string;
  position: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  position: row.position,
  archivedAt: iso(row.archivedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function toFaqSection(row: FaqSectionRow): FaqSection {
  return { ...record(row), title: row.title };
}

export function toFaqItem(row: FaqItemRow): FaqItem {
  return { ...record(row), sectionId: row.sectionId, question: row.question, answer: row.answer };
}

export function toBanner(row: BannerRow, now: Date): Banner {
  return {
    ...record(row),
    imageFileId: row.imageFileId,
    altText: row.altText,
    linkPath: row.linkPath,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    enabled: row.enabled,
    state: bannerState(row, now),
  };
}

export function toAnnouncement(row: AnnouncementRow, now: Date): Announcement {
  return {
    id: row.id,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    text: row.text,
    tone: row.tone,
    revision: row.revision,
    linkPath: row.linkPath,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    enabled: row.enabled,
    state: announcementState(row, now),
  };
}

/** The audit values of a banner (S14 "Audit"). */
export const bannerValues = (row: BannerRow) => ({
  imageFileId: row.imageFileId,
  altText: row.altText,
  linkPath: row.linkPath,
  startsAt: iso(row.startsAt),
  endsAt: iso(row.endsAt),
  enabled: row.enabled,
});

export const announcementValues = (row: AnnouncementRow) => ({
  text: row.text,
  tone: row.tone,
  revision: row.revision,
  linkPath: row.linkPath,
  startsAt: iso(row.startsAt),
  endsAt: iso(row.endsAt),
  enabled: row.enabled,
});

/**
 * Rule BN4 (and AN1): a start or end in the past is refused on save, unless it is the stored one.
 */
export function checkSchedule(
  input: { startsAt?: string | null; endsAt?: string | null },
  stored: { startsAt: Date | null; endsAt: Date | null } | null,
  now: Date,
): { startsAt: Date | null; endsAt: Date | null } {
  const result = {
    startsAt: input.startsAt == null ? null : new Date(input.startsAt),
    endsAt: input.endsAt == null ? null : new Date(input.endsAt),
  };
  for (const key of ['startsAt', 'endsAt'] as const) {
    const value = result[key];
    const unchanged = value?.getTime() === stored?.[key]?.getTime();
    if (value !== null && value.getTime() < now.getTime() && !unchanged) {
      throw refusals.invalid([key], 'Expected a time in the future');
    }
  }
  return result;
}
