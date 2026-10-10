'use client';

import type { StoreProduct } from '@vertex-digital/contracts';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@vertex-digital/ui/components/collapsible';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { t } from '@/lib/i18n';

export type CalculatorPack = StoreProduct & { gameAmount: number; priceUsdUnits: number };

/** Rule CL1: the packs the calculator combines: available `direct` packs with an amount. */
export function calculatorPacks(products: readonly StoreProduct[]): CalculatorPack[] {
  return products.filter(
    (product): product is CalculatorPack =>
      product.available &&
      product.kind === 'direct' &&
      product.gameAmount !== null &&
      product.gameAmount > 0 &&
      product.priceUsdUnits !== null,
  );
}

const Calculator = dynamic(() => import('./calculator').then((module) => module.Calculator), {
  loading: () => <Skeleton className="mx-4 mb-4 h-24" />,
});

/** "كم أحتاج؟" (rule CL1), folded; its body loads on the first open. */
export function CalculatorCard({
  packs,
  onBuy,
  onAddAll,
}: {
  packs: CalculatorPack[];
  onBuy: (packId: string, count: number) => void;
  onAddAll: (lines: { product: CalculatorPack; count: number }[]) => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Collapsible onOpenChange={(open) => open && setOpened(true)}>
      <Card className="gap-0 p-0">
        <CollapsibleTrigger className="min-h-12 px-4 text-lg font-bold">
          {t('calculator.title')}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {opened && <Calculator packs={packs} onBuy={onBuy} onAddAll={onAddAll} />}
        </CollapsiblePanel>
      </Card>
    </Collapsible>
  );
}
