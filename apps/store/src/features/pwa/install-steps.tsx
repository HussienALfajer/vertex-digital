'use client';

import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { type LucideIcon, ShareIcon, SmartphoneIcon, SquarePlusIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

const STEPS: { icon: LucideIcon; text: () => string }[] = [
  { icon: ShareIcon, text: () => t('pwa.ios.step1') },
  { icon: SquarePlusIcon, text: () => t('pwa.ios.step2') },
  { icon: SmartphoneIcon, text: () => t('pwa.ios.step3') },
];

function Steps() {
  return (
    <ol className="flex flex-col gap-3">
      {STEPS.map(({ icon: Icon, text }, index) => (
        <li key={text()} className="flex items-center gap-3">
          <IconTile>
            <Icon />
          </IconTile>
          <span>
            <span className="font-bold">{index + 1}. </span>
            {text()}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * IN1 on iPhone and iPad: Safari's three Add to Home Screen steps, a bottom sheet at phone width
 * and a dialog on wider screens. Loaded with `next/dynamic` on the first press.
 */
export function InstallSteps({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 40rem)');
    setWide(query.matches);
    const change = () => setWide(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  const done = (
    <Button size="xl" className="w-full sm:w-auto">
      {t('pwa.ios.close')}
    </Button>
  );
  if (wide) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="install-steps">
          <DialogTitle>{t('pwa.ios.title')}</DialogTitle>
          <DialogDescription>{t('pwa.ios.intro')}</DialogDescription>
          <Steps />
          <DialogClose render={done} />
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="install-steps"
        className="mx-auto w-full max-w-2xl gap-4 bg-surface p-5 pb-8"
      >
        <SheetTitle className="text-lg font-bold">{t('pwa.ios.title')}</SheetTitle>
        <p className="text-muted-foreground">{t('pwa.ios.intro')}</p>
        <Steps />
        <SheetClose render={done} />
      </SheetContent>
    </Sheet>
  );
}
