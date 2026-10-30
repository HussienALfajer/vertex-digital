'use client';

import type { MerchantTierSummary } from '@vertex-digital/contracts';
import { SuccessMark } from '@vertex-digital/ui/brand/success-mark';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { TierBadge } from '@vertex-digital/ui/components/tier-badge';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { tm } from './i18n';
import { getTier, markCelebrated } from './requests';
import { TierGrants } from './tier-card';
import { tierBadgeLabel } from './tier-parts';

/*
 * The merchant's tier across the merchant area (S23 ID2, ID4): read once in the browser by the
 * area's layout, shown as the badge beside the area's title, and given to the tier card and the
 * tier page. A failed read shows no badge (the pages show their own state); a newer read replaces
 * the shown one only.
 */

interface TierContextValue {
  tier: MerchantTierSummary | null;
  failed: boolean;
  reload: () => Promise<void>;
}

const TierContext = createContext<TierContextValue>({
  tier: null,
  failed: false,
  reload: async () => {},
});

export const useMerchantTier = () => useContext(TierContext);

export function MerchantTierProvider({ children }: { children: ReactNode }) {
  const [tier, setTier] = useState<MerchantTierSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const reading = ++latest.current;
    const result = await getTier();
    if (reading !== latest.current) return;
    if (result.ok) {
      setTier(result.data);
      setFailed(false);
    } else if (result.reason !== 'UNAUTHORIZED' && result.reason !== 'NOT_MERCHANT') {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <TierContext.Provider value={{ tier, failed, reload }}>
      {children}
      {tier?.celebrate && (
        <Celebration
          tier={tier}
          onSeen={() => setTier((current) => current && { ...current, celebrate: false })}
        />
      )}
    </TierContext.Provider>
  );
}

/** ID2: the badge beside the merchant area's title; a placeholder while it loads. */
export function MerchantTierBadge() {
  const { tier, failed } = useMerchantTier();
  if (failed) return null;
  if (!tier) return <Skeleton className="h-8 w-24" aria-hidden="true" />;
  return (
    <TierBadge tier={tier.tier} label={tierBadgeLabel(tier.tier)} data-testid="merchant-tier" />
  );
}

/**
 * ID4: once after a rise, a full-screen sheet with the new badge, what it grants and one short
 * motion (the mark's three strokes, then the badge; still under `prefers-reduced-motion`).
 * "متابعة" tells the API; the sheet closes at once, whatever the answer (it shows again on the next
 * visit if the call was lost).
 */
function Celebration({ tier, onSeen }: { tier: MerchantTierSummary; onSeen: () => void }) {
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onSeen();
    void markCelebrated();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="flex h-dvh max-h-dvh w-full max-w-none flex-col items-center justify-center gap-6 rounded-none text-center sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-md sm:rounded-xl"
        data-testid="tier-celebration"
      >
        <SuccessMark className="w-20 text-accent" />
        <TierBadge
          tier={tier.tier}
          size="lg"
          label={tierBadgeLabel(tier.tier)}
          className="motion-safe:animate-[vd-fade-in_250ms_ease-out_450ms_both]"
        />
        <DialogTitle className="text-2xl font-bold">
          {tm('tier.celebration.title', { badge: tierBadgeLabel(tier.tier) })}
        </DialogTitle>
        <DialogDescription>{tm('tier.celebration.body')}</DialogDescription>
        <TierGrants privileges={tier.privileges} className="w-full text-start" />
        <Button size="xl" className="w-full" onClick={close}>
          {tm('tier.celebration.continue')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
