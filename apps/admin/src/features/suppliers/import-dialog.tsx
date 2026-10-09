import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type ImportResult,
  importOffersSchema,
  PRODUCT_KINDS,
  type ProductKind,
  type SupplierDetail,
  type SupplierOffer,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { CircleCheckIcon, InfoIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { allGamesQuery, gameQuery } from '../catalog/catalog.queries';
import { type FieldMapEntry, fieldMapEntries, requiredFieldsOf, toFieldMap } from './field-map';
import { FieldMapEditor } from './field-map-editor';
import { useImportOffers } from './suppliers.queries';

/** A refused row as the API names it (`details.rows`, rule RT8). */
interface RowRefusal {
  index: number;
  code: string;
  fields?: string[];
}

/** The longest product name (rule RT8). */
const NAME_MAX = 60;

/**
 * "استيراد إلى لعبة" (rule RT8): the game, the kind of the offers whose kind is unknown, one
 * field map for the batch, and a name per offer. All or nothing: a refusal shows its rows'
 * errors in place; the products are created paused for the admin to review and resume.
 */
export function ImportDialog({
  supplier,
  offers,
  onImported,
}: {
  supplier: SupplierDetail;
  offers: SupplierOffer[];
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const games = useQuery(allGamesQuery);
  const importOffers = useImportOffers(supplier.code);
  const [gameId, setGameId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProductKind | null>(null);
  const [names, setNames] = useState(() => offers.map((offer) => offer.name.slice(0, NAME_MAX)));
  const required = requiredFieldsOf(offers);
  const [entries, setEntries] = useState<FieldMapEntry[]>(() => fieldMapEntries(required));
  const [errors, setErrors] = useState<{ game?: boolean; kind?: boolean; names: number[] }>({
    names: [],
  });
  const [refusals, setRefusals] = useState<RowRefusal[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const game = useQuery({ ...gameQuery(gameId ?? ''), enabled: gameId !== null });
  const kindUnknown = offers.some((offer) => offer.kind === null);
  const unknownFields = offers.filter((offer) => offer.requiredFields === null).length;
  const liveFields = game.data?.fields.filter((field) => field.archivedAt === null) ?? [];
  const missingFields = [...new Set(refusals.flatMap((refusal) => refusal.fields ?? []))];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setRefusals([]);
    const parsed = importOffersSchema.safeParse({
      gameId,
      kind: kindUnknown ? kind : undefined,
      fieldMap: toFieldMap(entries),
      rows: offers.map((offer, index) => ({ offerId: offer.id, nameAr: names[index] ?? '' })),
    });
    const issues = parsed.error?.issues ?? [];
    const found = {
      game: gameId === null,
      kind: kindUnknown && kind === null,
      names: issues
        .filter((issue) => issue.path[0] === 'rows' && issue.path[2] === 'nameAr')
        .map((issue) => Number(issue.path[1])),
    };
    setErrors(found);
    if (!parsed.success || found.game || found.kind) {
      if (parsed.error?.issues.some((issue) => issue.path[0] === 'fieldMap')) {
        setFailure(t('suppliers.import.errors.fieldMap'));
      }
      return;
    }
    try {
      setResult(await importOffers.mutateAsync(parsed.data));
      onImported();
    } catch (error) {
      const rows =
        error instanceof ApiError ? (error.details as { rows?: RowRefusal[] })?.rows : [];
      if (rows?.length) setRefusals(rows);
      else setFailure(errorMessage(t, error));
    }
  }

  if (result) {
    return (
      <DialogContent closeLabel={t('common.close')} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('suppliers.import.doneTitle')}</DialogTitle>
        </DialogHeader>
        <Callout
          tone="info"
          icon={<CircleCheckIcon />}
          title={t('suppliers.import.done', { count: result.products.length })}
          description={t('suppliers.import.doneHint')}
        />
        <DialogFooter>
          {gameId && (
            <Button
              render={
                <Link
                  to="/catalog/games/$id"
                  params={{ id: gameId }}
                  search={{ tab: 'products' }}
                />
              }
            >
              {t('suppliers.import.openGame')}
            </Button>
          )}
          <DialogClose render={<Button variant="outline" />}>{t('common.close')}</DialogClose>
        </DialogFooter>
      </DialogContent>
    );
  }

  const gameItems = (games.data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.nameAr,
  }));
  const kindItems = PRODUCT_KINDS.map((value) => ({
    value,
    label: t(`catalog.products.kinds.${value}`),
  }));
  const refusalOf = (index: number) => refusals.find((refusal) => refusal.index === index);

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('suppliers.import.title', { count: offers.length })}</DialogTitle>
        <DialogDescription>{t('suppliers.import.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={errors.game}>
            <FieldLabel>{t('suppliers.import.game')}</FieldLabel>
            {games.isPending ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select
                items={gameItems}
                value={gameId}
                onValueChange={(value) => {
                  setGameId(value);
                  setEntries(fieldMapEntries(required));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('suppliers.import.chooseGame')} />
                </SelectTrigger>
                <SelectContent>
                  {gameItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <FieldError match={errors.game}>{t('suppliers.import.errors.game')}</FieldError>
          </Field>
          {kindUnknown && (
            <Field invalid={errors.kind}>
              <FieldLabel>{t('suppliers.import.kind')}</FieldLabel>
              <Select
                items={kindItems}
                value={kind}
                onValueChange={(value) => setKind(value as ProductKind)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('suppliers.import.chooseKind')} />
                </SelectTrigger>
                <SelectContent>
                  {kindItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError match={errors.kind}>{t('suppliers.import.errors.kind')}</FieldError>
            </Field>
          )}
        </div>
        {gameId !== null &&
          (game.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <FieldMapEditor
              entries={entries}
              fields={liveFields}
              missing={missingFields}
              onChange={setEntries}
            />
          ))}
        {unknownFields > 0 && (
          <Callout
            tone="info"
            icon={<InfoIcon />}
            title={t('suppliers.import.unknownFields', { count: unknownFields })}
            description={t('suppliers.import.unknownFieldsHint')}
          />
        )}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-medium">{t('suppliers.import.names')}</legend>
          {offers.map((offer, index) => {
            const refusal = refusalOf(index);
            const invalid = errors.names.includes(index) || !!refusal;
            return (
              <Field key={offer.id} invalid={invalid}>
                <FieldLabel className="text-sm font-normal text-muted-foreground">
                  <bdi>{offer.name}</bdi>
                </FieldLabel>
                <Input
                  name={`name-${index}`}
                  autoComplete="off"
                  value={names[index] ?? ''}
                  onChange={(event) =>
                    setNames((previous) =>
                      previous.map((name, at) => (at === index ? event.target.value : name)),
                    )
                  }
                />
                <FieldError match={invalid}>
                  {refusal
                    ? rowMessage(t, refusal)
                    : t('suppliers.import.errors.name', { max: NAME_MAX })}
                </FieldError>
              </Field>
            );
          })}
        </fieldset>
        {refusals.length > 0 && <FormAlert>{t('suppliers.import.refused')}</FormAlert>}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={importOffers.isPending}>
            {importOffers.isPending
              ? t('suppliers.import.submitting')
              : t('suppliers.import.submit', { count: offers.length })}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** A refused row's code in words, with the supplier fields left unmapped (rule RT3). */
function rowMessage(t: TFunction, refusal: RowRefusal): string {
  const message = errorMessage(t, new ApiError(409, refusal.code, undefined, refusal.code));
  return refusal.fields?.length ? `${message} (${refusal.fields.join('، ')})` : message;
}
