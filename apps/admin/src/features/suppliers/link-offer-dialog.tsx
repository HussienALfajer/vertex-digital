import { useQuery } from '@tanstack/react-query';
import type { LinkCandidate, SupplierOffer } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  cn,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Skeleton,
} from '@vertex-digital/ui';
import { SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReadFailure } from '../../components/read-failure';
import { gameQuery } from '../catalog/catalog.queries';
import { AddRouteDialog } from './add-route-dialog';
import { linkCandidatesQuery } from './suppliers.queries';
import { TipButton } from './tip-button';

const REASON_TONES: Record<LinkCandidate['reason'], 'success' | 'info' | 'outline'> = {
  amount: 'success',
  game: 'info',
  search: 'outline',
};

/**
 * S18 "ربط بباقة": an offer added as a route of an existing pack. The packs of the offer's
 * category game come first, those of its amount at the top, and a search finds any other pack;
 * a chosen pack opens the route form (field map, options, price basis, timing) with the offer
 * already chosen, so a suggested pack is linked in two or three clicks.
 */
export function LinkOfferDialog({ offer, onDone }: { offer: SupplierOffer; onDone: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<LinkCandidate | null>(null);
  const candidates = useQuery(linkCandidatesQuery(offer.id, query));
  const game = useQuery({ ...gameQuery(chosen?.gameId ?? ''), enabled: chosen !== null });

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = q.trim();
    setQuery(value.length >= 1 && value.length <= 100 ? value : undefined);
  }

  const product = chosen && game.data?.products.find((item) => item.id === chosen.productId);
  if (chosen && game.data && product) {
    return (
      <AddRouteDialog game={game.data} product={product} presetOffer={offer} onDone={onDone} />
    );
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('suppliers.link.title')}</DialogTitle>
        <DialogDescription>
          <bdi>{offer.name}</bdi>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <form className="flex items-end gap-2" onSubmit={search}>
          <Field className="flex-1">
            <FieldLabel>{t('suppliers.link.search')}</FieldLabel>
            <Input
              name="packSearch"
              value={q}
              placeholder={t('suppliers.link.searchPlaceholder')}
              onChange={(event) => setQ(event.target.value)}
            />
          </Field>
          <TipButton type="submit" variant="outline" size="icon" label={t('suppliers.link.search')}>
            <SearchIcon />
          </TipButton>
        </form>
        {candidates.isPending && <Skeleton className="h-40 w-full" />}
        {candidates.isError && (
          <ReadFailure error={candidates.error} onRetry={() => candidates.refetch()} />
        )}
        {game.isError && <ReadFailure error={game.error} onRetry={() => game.refetch()} />}
        {candidates.isSuccess &&
          (candidates.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query ? t('suppliers.link.noMatch') : t('suppliers.link.noSuggestion')}
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {candidates.data.map((candidate) => (
                <li key={candidate.productId}>
                  <button
                    type="button"
                    aria-pressed={chosen?.productId === candidate.productId}
                    disabled={game.isFetching}
                    onClick={() => setChosen(candidate)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-start text-sm transition-colors duration-150 ease-out hover:bg-muted',
                      chosen?.productId === candidate.productId
                        ? 'border-primary bg-muted'
                        : 'border-border',
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <bdi className="font-medium">{candidate.productNameAr}</bdi>
                      <bdi className="text-xs text-muted-foreground">{candidate.gameNameAr}</bdi>
                    </span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      <Badge tone={REASON_TONES[candidate.reason]}>
                        {t(`suppliers.link.reasons.${candidate.reason}`)}
                      </Badge>
                      {candidate.routedBySupplier && (
                        <Badge tone="neutral">{t('suppliers.link.routed')}</Badge>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {chosen && game.isFetching && <Skeleton className="h-10 w-full" />}
        <Button variant="ghost" className="self-start" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </DialogContent>
  );
}
