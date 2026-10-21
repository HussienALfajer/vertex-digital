import { depositGap } from '@vertex-digital/contracts';
import { centsParam } from '@/features/deposits/amounts';
import { getWallet } from '@/features/wallet/requests';

/**
 * S22 BG2: where "احجز واشحن الفرق" goes once the reservation is made: the deposit form with the
 * gap the server's balance and reservations give now (this one included), or the order when a
 * credit already covers it.
 */
export async function gapDepositPath(order: { id: string; number: string }): Promise<string> {
  const wallet = await getWallet();
  const gap = wallet.ok
    ? depositGap({
        totalUsdUnits: 0,
        balanceUsdUnits: wallet.data.balanceUnits,
        reservedUsdUnits: wallet.data.reservedUsdUnits,
      })
    : null;
  if (gap === 0) return `/orders/${order.id}`;
  const query = new URLSearchParams({ order: order.id, number: order.number });
  if (gap !== null) query.set('gap', centsParam(gap));
  return `/wallet/deposit?${query.toString()}`;
}
