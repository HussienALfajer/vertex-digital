import { useQuery } from '@tanstack/react-query';
import type { ActivateAllResult } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui';
import { ZapIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { gameQuery } from '../catalog/catalog.queries';
import { catalogFailure } from '../catalog/catalog-parts';
import { useActivateAll } from './suppliers.queries';

/**
 * "تفعيل الكل" (S16 SC10): the confirmation counts the paused packs first (packs the admin paused
 * one by one are activated too), then the result lists the activated packs and the skipped ones
 * with their reason. `CATALOG_INCOMPLETE` names what the game lacks; nothing changes then.
 */
export function ActivateAllButton({
  gameId,
  variant = 'primary',
}: {
  gameId: string;
  variant?: 'primary' | 'outline';
}) {
  const { t } = useTranslation();
  const game = useQuery(gameQuery(gameId));
  const activate = useActivateAll(gameId);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActivateAllResult | null>(null);
  const paused =
    game.data?.products.filter((item) => item.status === 'paused' && item.archivedAt === null)
      .length ?? 0;

  return (
    <>
      <Button variant={variant} disabled={!game.isSuccess} onClick={() => setConfirming(true)}>
        <ZapIcon />
        {t('suppliers.activateAll.button')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('suppliers.activateAll.title')}
        body={t('suppliers.activateAll.body', {
          count: paused,
          game: game.data?.status === 'paused' ? t('suppliers.activateAll.andGame') : '',
        })}
        action={t('suppliers.activateAll.confirm')}
        pending={activate.isPending}
        onConfirm={async () => {
          setResult(await activate.mutateAsync(undefined));
        }}
        describeFailure={(error) => catalogFailure(t, error)}
      />
      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        {result && (
          <DialogContent closeLabel={t('common.close')} className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('suppliers.activateAll.doneTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {result.gameActivated && (
                <p className="text-sm">{t('suppliers.activateAll.gameActivated')}</p>
              )}
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">
                  {t('suppliers.activateAll.activated', { count: result.activated.length })}
                </h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {result.activated.map((item) => (
                    <li key={item.productId}>
                      <bdi>{item.nameAr}</bdi>
                    </li>
                  ))}
                </ul>
              </section>
              {result.skipped.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="font-medium">
                    {t('suppliers.activateAll.skipped', { count: result.skipped.length })}
                  </h3>
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {result.skipped.map((item) => (
                      <li key={item.productId} className="flex flex-wrap items-center gap-2">
                        <bdi>{item.nameAr}</bdi>
                        <Badge tone="warning">
                          {t(`suppliers.activateAll.reasons.${item.reason}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>{t('common.close')}</DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
