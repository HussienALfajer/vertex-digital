import { useQuery } from '@tanstack/react-query';
import {
  formatUsd,
  type GameDetail,
  type Product,
  type SupplierCode,
  type SupplierOffer,
} from '@vertex-digital/contracts';
import {
  Button,
  cn,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { type FieldMapEntry, fieldMapEntries, toFieldMap, unmappedOf } from './field-map';
import { FieldMapEditor } from './field-map-editor';
import { offersQuery, suppliersQuery, useCreateRoute } from './suppliers.queries';

/**
 * "إضافة مسار" (rules RT1–RT3): a supplier, then one of its unmapped offers found by name or id,
 * then the field map from its required fields to the game's fields. The API refuses a second
 * route to the same supplier, a mapped offer and a kind mismatch.
 */
export function AddRouteDialog({
  game,
  product,
  onDone,
}: {
  game: GameDetail;
  product: Product;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const suppliers = useQuery(suppliersQuery);
  const create = useCreateRoute(product.id);
  const [code, setCode] = useState<SupplierCode | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [offer, setOffer] = useState<SupplierOffer | null>(null);
  const [entries, setEntries] = useState<FieldMapEntry[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const offers = useQuery({
    ...offersQuery(code ?? 'fake', { q: query, mapped: 'false', missing: 'false' }),
    enabled: code !== null,
  });
  const supplierItems = (suppliers.data ?? [])
    .filter((supplier) => supplier.code !== 'manual')
    .map((supplier) => ({ value: supplier.code, label: supplier.nameAr }));

  function choose(next: SupplierOffer) {
    setOffer(next);
    setEntries(fieldMapEntries(next.requiredFields ?? []));
    setMissing([]);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = q.trim();
    setQuery(value.length >= 1 && value.length <= 100 ? value : undefined);
  }

  async function submit() {
    if (!offer) return;
    setFailure(null);
    try {
      await create.mutateAsync({ offerId: offer.id, fieldMap: toFieldMap(entries) });
      onDone();
    } catch (error) {
      setMissing(unmappedOf(error));
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('suppliers.routes.addTitle')}</DialogTitle>
        <DialogDescription>
          <bdi>{product.nameAr}</bdi>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-5">
        <Field>
          <FieldLabel>{t('suppliers.routes.supplier')}</FieldLabel>
          {suppliers.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              items={supplierItems}
              value={code}
              onValueChange={(value) => {
                setCode(value as SupplierCode);
                setOffer(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('suppliers.routes.chooseSupplier')} />
              </SelectTrigger>
              <SelectContent>
                {supplierItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {code !== null && (
          <section className="flex flex-col gap-3" aria-labelledby="offer-search">
            <form className="flex items-end gap-2" onSubmit={search}>
              <Field className="flex-1">
                <FieldLabel id="offer-search">{t('suppliers.routes.offerSearch')}</FieldLabel>
                <Input
                  name="offerSearch"
                  value={q}
                  placeholder={t('suppliers.offers.searchPlaceholder')}
                  onChange={(event) => setQ(event.target.value)}
                />
              </Field>
              <Button type="submit" variant="outline">
                {t('suppliers.offers.searchSubmit')}
              </Button>
            </form>
            {offers.isPending && <Skeleton className="h-32 w-full" />}
            {offers.isError && <FormAlert>{errorMessage(t, offers.error)}</FormAlert>}
            {offers.isSuccess &&
              (offers.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('suppliers.routes.noOffers')}</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                  {offers.data.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={offer?.id === item.id}
                        onClick={() => choose(item)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-start text-sm transition-colors duration-150 ease-out hover:bg-muted',
                          offer?.id === item.id ? 'border-primary bg-muted' : 'border-border',
                        )}
                      >
                        <span className="flex min-w-0 flex-col">
                          <bdi className="font-medium">{item.name}</bdi>
                          <bdi dir="ltr" className="text-xs text-muted-foreground">
                            {item.offerId}
                          </bdi>
                        </span>
                        <bdi dir="ltr" className="tabular-nums">
                          {item.costUsdUnits === null ? '—' : formatUsd(item.costUsdUnits)}
                        </bdi>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </section>
        )}
        {offer && (
          <>
            {offer.requiredFields === null && (
              <p className="text-sm text-muted-foreground">
                {t('suppliers.routes.requirementsUnknownHint')}
              </p>
            )}
            <FieldMapEditor
              entries={entries}
              fields={game.fields.filter((field) => field.archivedAt === null)}
              missing={missing}
              onChange={setEntries}
            />
          </>
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
      </div>
      <DialogFooter>
        <Button disabled={!offer || create.isPending} onClick={submit}>
          {create.isPending ? t('suppliers.routes.adding') : t('suppliers.routes.addSubmit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
