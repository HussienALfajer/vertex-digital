'use client';

import { MerchantSectionsButton, MerchantSidebar } from './merchant-nav';
import { SaleSwitch } from './sale-switch';
import { MerchantTierProvider } from './tier-state';

/**
 * A merchant's tools on the home page: the sidebar beside the page from `lg`, and the bar above it
 * with the sale switch and, below `lg`, the button that opens the same panel. Direct children of
 * the page's grid (`app/page.tsx`).
 */
export function HomeTools() {
  return (
    <MerchantTierProvider>
      <MerchantSidebar className="lg:col-start-1 lg:row-span-2 lg:row-start-1" />
      <div className="border-b border-border lg:col-start-2 lg:row-start-1">
        <div className="mx-auto flex min-h-17 w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <MerchantSectionsButton compact />
          <div className="ms-auto">
            <SaleSwitch />
          </div>
        </div>
      </div>
    </MerchantTierProvider>
  );
}
