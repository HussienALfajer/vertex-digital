import { Button } from '@vertex-digital/ui';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '../../lib/clipboard';

/**
 * Backup codes, shown once: a grid to write down, and buttons to copy them all or download them as
 * text, wherever they are shown (the enrolment and the account page, S01 screens; A01-28).
 */
export function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  const { copy, copied } = useCopy();

  function download() {
    const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('account.backupCodes.fileName');
    link.click();
    // Released after the browser has started the download: revoking at once can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

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
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => copy(codes.join('\n'))}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t('common.copied') : t('twoFactorSetup.copyCodes')}
        </Button>
        <Button variant="outline" onClick={download}>
          <DownloadIcon />
          {t('account.backupCodes.download')}
        </Button>
      </div>
    </div>
  );
}
