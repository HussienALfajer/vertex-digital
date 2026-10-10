import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { ExternalLinkIcon, SendIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { telegramSupportUrl } from './data';

/**
 * "تواصل معنا على تيليغرام" on `/support` (S12 SC2) when the panel sets a link, read at request
 * time from the cached channels route. Nothing when none is set.
 */
export async function TelegramCard() {
  const url = await telegramSupportUrl();
  if (!url) return null;
  return (
    <Card className="gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <IconTile>
          <SendIcon />
        </IconTile>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold">{t('support.telegram.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('support.telegram.body')}</p>
        </div>
      </div>
      <Button
        variant="outline"
        size="xl"
        className="shrink-0"
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      >
        {t('support.telegram.open')}
        <ExternalLinkIcon aria-hidden="true" />
      </Button>
    </Card>
  );
}
