import type { MerchantTierSummary } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { ExternalLinkIcon, MessageCircleIcon, SendIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/**
 * S23 OP4: "تواصل مباشر" for a Diamond merchant: the WhatsApp and Telegram buttons the panel set,
 * each only when set. `GET /api/merchant/tier` sends the links to such merchants only; nothing
 * shows without them.
 */
export function DirectContact({ contact }: { contact: MerchantTierSummary['contact'] }) {
  if (!contact) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="direct-contact">
      <p className="text-sm font-medium">{t('merchant.contact.title')}</p>
      <div className="flex flex-wrap gap-2">
        {contact.whatsappUrl && (
          <Button
            variant="outline"
            size="xl"
            render={<a href={contact.whatsappUrl} target="_blank" rel="noopener noreferrer" />}
          >
            <MessageCircleIcon aria-hidden="true" />
            {t('merchant.contact.whatsapp')}
            <ExternalLinkIcon aria-hidden="true" />
          </Button>
        )}
        {contact.telegramUrl && (
          <Button
            variant="outline"
            size="xl"
            render={<a href={contact.telegramUrl} target="_blank" rel="noopener noreferrer" />}
          >
            <SendIcon aria-hidden="true" />
            {t('merchant.contact.telegram')}
            <ExternalLinkIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
