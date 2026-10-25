'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import {
  BellIcon,
  BellOffIcon,
  BellRingIcon,
  LoaderCircleIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { useInstall } from '@/features/pwa/install-button';
import type { Failure } from '@/lib/api';
import { t } from '@/lib/i18n';
import { enablePush } from './device';
import { dismissCard } from './dismissal';

type View =
  | { step: 'offer'; failure?: Failure }
  | { step: 'working' }
  | { step: 'done' }
  | { step: 'denied' }
  | { step: 'closed' };

/**
 * PC2, PC3: "فعّل" asks for permission only on the tap, subscribes and registers this device. A
 * dismissed prompt or "لاحقًا" counts as later (30 days); a denial shows how to allow it from the
 * browser's site settings. iOS Safari outside the installed app shows the install steps instead.
 */
export function PermissionCard({
  kind,
  publicKey,
  support,
}: {
  kind: 'order' | 'deposit' | 'alert';
  publicKey: string;
  support: 'push' | 'ios-install';
}) {
  const [view, setView] = useState<View>({ step: 'offer' });
  const install = useInstall();

  const later = () => {
    dismissCard();
    setView({ step: 'closed' });
  };
  const enable = async () => {
    setView({ step: 'working' });
    const result = await enablePush(publicKey);
    if (result.outcome === 'enabled') return setView({ step: 'done' });
    if (result.outcome === 'denied') return setView({ step: 'denied' });
    if (result.outcome === 'dismissed') return later();
    setView({ step: 'offer', failure: result.reason });
  };

  if (view.step === 'closed') return null;
  if (view.step === 'done') {
    return (
      <Card data-testid="push-card" className="flex-row items-center gap-3" role="status">
        <IconTile tone="success">
          <BellRingIcon />
        </IconTile>
        <p className="font-medium">{t('push.card.done')}</p>
      </Card>
    );
  }
  if (view.step === 'denied') {
    return (
      <Card data-testid="push-card" className="flex-row items-start gap-3" role="status">
        <IconTile>
          <BellOffIcon />
        </IconTile>
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('push.denied.title')}</p>
          <p className="text-sm text-muted-foreground">{t('push.denied.hint')}</p>
        </div>
      </Card>
    );
  }

  const ios = support === 'ios-install';
  return (
    <Card data-testid="push-card" className="gap-4">
      <div className="flex items-start gap-3">
        <IconTile>{ios ? <SmartphoneIcon /> : <BellIcon />}</IconTile>
        <div className="flex flex-col gap-1">
          <p className="font-medium">{ios ? t('push.card.ios') : t(`push.card.${kind}`)}</p>
          <p className="text-sm text-muted-foreground">{t('push.card.body')}</p>
        </div>
      </div>
      {view.step === 'offer' && view.failure && <FormAlert>{t('push.card.failed')}</FormAlert>}
      <div className="flex flex-wrap gap-2">
        {ios ? (
          <Button size="xl" onClick={install.start}>
            {t('push.card.iosSteps')}
          </Button>
        ) : (
          <Button
            size="xl"
            onClick={() => void enable()}
            disabled={view.step === 'working'}
            aria-busy={view.step === 'working'}
          >
            {view.step === 'working' && (
              <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
            )}
            {t('push.card.enable')}
          </Button>
        )}
        <Button variant="ghost" size="xl" onClick={later} disabled={view.step === 'working'}>
          {t('push.card.later')}
        </Button>
      </div>
      {install.steps}
    </Card>
  );
}
