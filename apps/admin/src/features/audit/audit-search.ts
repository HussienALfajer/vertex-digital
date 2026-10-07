import {
  type AuditAction,
  type AuditActorKind,
  type AuditEntityType,
  type AuditListQuery,
  auditActionSchema,
  auditActorKindSchema,
  auditEntityTypeSchema,
} from '@vertex-digital/contracts';

/**
 * The audit log filters as the URL holds them (rule A4), so a filtered view can be reloaded and
 * shared. Dates are calendar days (`2026-10-08`) in the viewer's time zone.
 */
export interface AuditSearch {
  actorKind?: AuditActorKind;
  actorId?: string;
  action?: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  from?: string;
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (value: string) => UUID.test(value);

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Keeps only the filters that are valid; anything else in the URL is dropped. */
export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const parsed: AuditSearch = {};
  const actorKind = auditActorKindSchema.safeParse(search.actorKind);
  if (actorKind.success) parsed.actorKind = actorKind.data;
  const actorId = text(search.actorId);
  // One actor's entries only make sense with the kind of actor (customer or admin).
  if (parsed.actorKind && isUuid(actorId)) parsed.actorId = actorId.toLowerCase();
  const action = auditActionSchema.safeParse(search.action);
  if (action.success) parsed.action = action.data;
  const entityType = auditEntityTypeSchema.safeParse(search.entityType);
  if (entityType.success) parsed.entityType = entityType.data;
  const entityId = text(search.entityId);
  if (isUuid(entityId)) parsed.entityId = entityId.toLowerCase();
  for (const key of ['from', 'to'] as const) {
    const day = text(search[key]);
    if (DAY.test(day) && !Number.isNaN(localDay(day).getTime())) parsed[key] = day;
  }
  return parsed;
}

/** Midnight of a calendar day in the viewer's time zone. */
function localDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date);
}

/** The API query of the filters: whole days from the start of `from` to the end of `to`. */
export function toAuditQuery(search: AuditSearch): Omit<AuditListQuery, 'limit' | 'cursor'> {
  const { from, to, ...rest } = search;
  const query: Omit<AuditListQuery, 'limit' | 'cursor'> = { ...rest };
  if (from) query.from = localDay(from).toISOString();
  if (to) {
    const end = localDay(to);
    end.setDate(end.getDate() + 1);
    query.to = new Date(end.getTime() - 1).toISOString();
  }
  return query;
}
