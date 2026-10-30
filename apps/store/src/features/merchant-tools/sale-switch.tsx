'use client';

import { Switch } from '@vertex-digital/ui/components/switch';
import { StoreIcon } from 'lucide-react';
import { useId } from 'react';
import { tm } from './i18n';
import { setSaleMode, useSaleMode } from './sale-mode';

/** "وضع البيع" (S21 PS1): the merchant's switch on the home and game pages, on until turned off. */
export function SaleSwitch() {
  const id = useId();
  const on = useSaleMode();
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface px-3"
    >
      <StoreIcon className="size-5 text-accent-text" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-sm font-medium">{tm('nav.saleMode')}</span>
      <Switch id={id} checked={on} onCheckedChange={setSaleMode} />
    </label>
  );
}
