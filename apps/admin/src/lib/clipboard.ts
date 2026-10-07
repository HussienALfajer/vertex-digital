import { toast } from '@vertex-digital/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Copies text and reports `copied` for two seconds, for a "Copied" confirmation on the button.
 * When the browser refuses (the page is not focused, or a policy blocks the clipboard), a toast
 * asks the user to select and copy the text by hand.
 */
export function useCopy() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast.add({ title: t('common.copyFailed'), type: 'error' });
        return;
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    },
    [t],
  );

  return { copy, copied };
}
