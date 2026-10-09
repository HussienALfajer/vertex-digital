'use client';

import { Card } from '@vertex-digital/ui/components/card';
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@vertex-digital/ui/components/collapsible';
import { CircleHelpIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';

/** "أين أجد المعرّف؟" on the game page (S09 screens): the guide image (`children`), folded. */
export function IdGuidePanel({ children }: { children: ReactNode }) {
  return (
    <Collapsible>
      <Card className="gap-0 p-0">
        <CollapsibleTrigger className="min-h-12 px-4 text-base font-medium">
          <CircleHelpIcon className="size-5 shrink-0" aria-hidden="true" />
          {t('purchase.whereIsId')}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="px-4 pb-4">{children}</div>
        </CollapsiblePanel>
      </Card>
    </Collapsible>
  );
}
