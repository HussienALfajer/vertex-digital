'use client';

import type { CatalogImage } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@vertex-digital/ui/components/dialog';
import { CircleHelpIcon } from 'lucide-react';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { t } from '@/lib/i18n';

/** "أين أجد المعرّف؟" (rule BB1): the game's ID guide image in a dialog. */
export function IdGuideButton({ image, gameName }: { image: CatalogImage; gameName: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="link" size="xl" className="self-start px-0" />}>
        <CircleHelpIcon aria-hidden="true" />
        {t('purchase.whereIsId')}
      </DialogTrigger>
      <DialogContent closeLabel={t('purchase.close')}>
        <DialogHeader>
          <DialogTitle>{t('purchase.whereIsId')}</DialogTitle>
        </DialogHeader>
        <CatalogPicture
          image={image}
          sizes="(min-width: 32rem) 30rem, 90vw"
          alt={t('purchase.idGuideAlt', { game: gameName })}
          className="h-auto w-full"
        />
      </DialogContent>
    </Dialog>
  );
}
