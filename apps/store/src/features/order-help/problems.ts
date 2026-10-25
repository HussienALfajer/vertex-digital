import type { OrderProblem, OrderStatus } from '@vertex-digital/contracts';
import { th } from './i18n';

const IN_PROGRESS: readonly OrderStatus[] = ['paid', 'sent_to_supplier', 'failed', 'needs_review'];

/** OP2's button text: "تأخر الطلب" while the order is on its way, "لم يصل الشحن" after. */
export function problemLabel(problem: OrderProblem, status: OrderStatus): string {
  if (problem === 'not_arrived' && IN_PROGRESS.includes(status))
    return th('problems.not_arrived_waiting');
  return th(`problems.${problem}`);
}

/**
 * OP5: the ticket's subject ("<problem> · <order number>", at most 120 characters) and body (the
 * problem's sentence, then what the customer added).
 */
export function problemTicket(
  problem: OrderProblem,
  status: OrderStatus,
  orderNumber: string,
  details: string,
): { subject: string; body: string } {
  const extra = details.replace(/\r\n?/g, '\n').trim();
  return {
    subject: `${problemLabel(problem, status)} · ${orderNumber}`.slice(0, 120),
    body: extra ? `${th(`sentences.${problem}`)}\n\n${extra}` : th(`sentences.${problem}`),
  };
}
