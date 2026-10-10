'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { DownloadIcon, Share2Icon } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/lib/i18n';

/**
 * "تنزيل الصورة" (the square image, rule SH2) and "مشاركة" (the Web Share API, falling back to
 * copying the page's address) under a gift or receipt.
 */
export function ShareActions({ token, fileName }: { token: string; fileName: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) return await navigator.share({ url });
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The visitor closed the share sheet, or the clipboard was refused: nothing to do.
    }
  }

  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button
        variant="outline"
        size="xl"
        render={
          <a
            href={`/api/shares/${encodeURIComponent(token)}/image?format=square`}
            download={fileName}
          />
        }
      >
        <DownloadIcon aria-hidden="true" />
        {t('share.download')}
      </Button>
      <Button variant="outline" size="xl" onClick={() => void share()}>
        <Share2Icon aria-hidden="true" />
        <span aria-live="polite">{copied ? t('share.copied') : t('share.share')}</span>
      </Button>
    </div>
  );
}
