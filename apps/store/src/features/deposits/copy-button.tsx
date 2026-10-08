'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

/** How long "نُسخ" stays after a copy. */
const COPIED_MS = 2000;

/**
 * Copies `value` (the account number, the amount, the reference code) and says "نُسخ" for a
 * moment (rule SC7). Where the clipboard is refused, it says to copy by hand.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xl"
      className="shrink-0 px-3"
      aria-label={state === 'copied' ? t('deposits.copied') : label}
      onClick={() => void copy()}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">
        {state === 'copied'
          ? t('deposits.copied')
          : state === 'failed'
            ? t('deposits.copyFailed')
            : t('deposits.copy')}
      </span>
    </Button>
  );
}
