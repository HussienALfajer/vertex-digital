import { Button } from '@vertex-digital/ui';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '../../lib/clipboard';

/** Backup codes, shown once: a grid to write down, and a button to copy them all. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  const { copy, copied } = useCopy();
  return (
    <div className="flex flex-col gap-3">
      <ol
        dir="ltr"
        className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-4"
      >
        {codes.map((code, index) => (
          <li key={code} className="flex items-center gap-3 rounded-md bg-surface px-3 py-2">
            <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
            <span className="text-base font-medium tabular-nums select-all">{code}</span>
          </li>
        ))}
      </ol>
      <Button variant="outline" className="self-start" onClick={() => copy(codes.join('\n'))}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? t('common.copied') : t('twoFactorSetup.copyCodes')}
      </Button>
    </div>
  );
}
