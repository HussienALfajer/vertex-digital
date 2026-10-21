import type { DepositLimits } from '@vertex-digital/contracts';
import { Callout } from '@vertex-digital/ui/components/callout';
import { ReceiptIcon } from 'lucide-react';
import { tq } from '@/features/quick-buy/i18n';
import { type GapFill, usdText } from './amounts';

/** S22 BG3: the amount a purchase or a reservation needs, above the method choice. */
export function GapStrip({
  gapUnits,
  orderNumber,
}: {
  gapUnits: number;
  orderNumber: string | null;
}) {
  return (
    <Callout
      tone="info"
      icon={<ReceiptIcon />}
      title={
        orderNumber
          ? tq('deposit.forOrder', { number: orderNumber, amount: usdText(gapUnits) })
          : tq('deposit.needed', { amount: usdText(gapUnits) })
      }
      description={tq('deposit.editable')}
    />
  );
}

/** S22 BG3: why the field holds more (the minimum) or less (a cap) than the gap. */
export function GapLines({ fill, limits }: { fill: GapFill; limits: DepositLimits | null }) {
  if (!limits || (!fill.raisedToMinimum && !fill.short)) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {fill.raisedToMinimum
        ? tq('deposit.minimum', { amount: usdText(limits.minUnits) })
        : tq('deposit.short')}
    </p>
  );
}
