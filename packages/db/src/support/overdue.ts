import type { MerchantTier } from '@vertex-digital/contracts';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { currentTierSettings } from '../merchants/tiers.js';
import type { JobSender } from '../notifications/index.js';
import { customers, merchantLevels, merchantProfiles, supportTickets } from '../schema/index.js';
import { queueTelegramMessage } from '../telegram/index.js';

/*
 * S23 OP6: open tickets of merchants whose tier promises a reply, waiting past the promise. One
 * Telegram `ticket_overdue` per waiting period: the dedupe key carries the last customer message's
 * time, so a new customer message starts a new period and the same period is told once.
 */

export interface OverdueTicket {
  ticketId: string;
  number: string;
  subject: string;
  tier: MerchantTier;
  tradeName: string;
  replyMinutes: number;
  lastCustomerMessageAt: Date;
}

/** OP6: the open tickets waiting past their merchant's tier promise at `now`, oldest first. */
export async function overdueTickets(db: Executor, now: Date): Promise<OverdueTicket[]> {
  const settings = await currentTierSettings(db);
  const promised = Object.entries(settings).filter(([, row]) => row.supportReplyMinutes !== null);
  if (promised.length === 0) return [];
  const rows = await db
    .select({
      ticketId: supportTickets.id,
      number: supportTickets.number,
      subject: supportTickets.subject,
      lastCustomerMessageAt: supportTickets.lastCustomerMessageAt,
      tradeName: merchantProfiles.tradeName,
      tier: sql<MerchantTier>`coalesce(${merchantLevels.tier}, 'bronze')`,
    })
    .from(supportTickets)
    .innerJoin(customers, eq(customers.id, supportTickets.customerId))
    .innerJoin(
      merchantProfiles,
      and(
        eq(merchantProfiles.customerId, supportTickets.customerId),
        isNull(merchantProfiles.revokedAt),
      ),
    )
    .leftJoin(
      merchantLevels,
      and(eq(merchantLevels.id, merchantProfiles.levelId), isNull(merchantLevels.archivedAt)),
    )
    .where(
      and(
        eq(supportTickets.status, 'open'),
        eq(customers.accountType, 'merchant'),
        isNotNull(supportTickets.lastCustomerMessageAt),
      ),
    )
    .orderBy(asc(supportTickets.lastCustomerMessageAt), asc(supportTickets.id));
  return rows.flatMap((row) => {
    const minutes = settings[row.tier].supportReplyMinutes;
    const at = row.lastCustomerMessageAt;
    if (minutes === null || at === null) return [];
    if (now.getTime() - at.getTime() <= minutes * 60_000) return [];
    return [
      {
        ticketId: row.ticketId,
        number: row.number,
        subject: row.subject,
        tier: row.tier,
        tradeName: row.tradeName,
        replyMinutes: minutes,
        lastCustomerMessageAt: at,
      },
    ];
  });
}

/** OP6: the ticket's Telegram notice, once per waiting period; false when already told. */
export async function tellTicketOverdue(
  tx: Transaction,
  jobs: JobSender,
  ticket: OverdueTicket,
  now: Date,
): Promise<boolean> {
  const id = await queueTelegramMessage(tx, jobs, {
    kind: 'ticket_overdue',
    params: {
      ticketId: ticket.ticketId,
      number: ticket.number,
      subject: ticket.subject.slice(0, 120),
      tier: ticket.tier,
      tradeName: ticket.tradeName,
      replyMinutes: ticket.replyMinutes,
      waitingMinutes: Math.max(
        1,
        Math.floor((now.getTime() - ticket.lastCustomerMessageAt.getTime()) / 60_000),
      ),
    },
    dedupeKey: `ticket-overdue:${ticket.ticketId}:${ticket.lastCustomerMessageAt.toISOString()}`,
  });
  return id !== null;
}
