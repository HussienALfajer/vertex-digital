import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type CategoryImportResult,
  type ImportDraft,
  linkCategorySchema,
  MAX_IMPORT_ROWS,
  type OptionMap,
  type SupplierCategoryNode,
  type SupplierDetail,
  unmappedOptions,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SheetClose,
  SheetContent,
  SheetTitle,
  Skeleton,
} from '@vertex-digital/ui';
import { CircleCheckIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { allGamesQuery, gameQuery } from '../catalog/catalog.queries';
import {
  alignedRows,
  initialPackRows,
  linkBody,
  type PackRow,
  packGroups,
  type RowRefusal,
  refusalsByOffer,
  sentOffers,
  withOptionRefusals,
} from './category-import';
import {
  type FieldMapEntry,
  fieldMapEntries,
  requiredFieldsOf,
  toFieldMap,
  unmappedOf,
} from './field-map';
import { FieldMapEditor } from './field-map-editor';
import { PackFacts, packRefusal, Section } from './import-category-sheet';
import { gameSelects, OptionMapEditor, supplierSelects } from './option-map-editor';
import { importDraftQuery, useLinkCategory } from './suppliers.queries';

type PackMode = 'existing' | 'new' | 'skip';

const modeOf = (row: PackRow): PackMode =>
  !row.selected ? 'skip' : row.productId ? 'existing' : 'new';

/**
 * "ربط بلعبة موجودة" (S16 SC8): the game, the field map onto its fields (RT3), and per pack an
 * existing product (the draft proposes the one with the same amount or name), a new paused pack,
 * or left out (it then counts as new, SC5). All or nothing, refused rows shown in place.
 */
export function LinkCategorySheet({
  supplier,
  node,
}: {
  supplier: SupplierDetail;
  node: SupplierCategoryNode;
}) {
  const { t } = useTranslation();
  const games = useQuery(allGamesQuery);
  const [gameId, setGameId] = useState<string | null>(node.game?.id ?? null);
  const draft = useQuery({
    ...importDraftQuery(supplier.code, node.categoryId, gameId ?? undefined),
    enabled: gameId !== null,
  });
  const gameItems = (games.data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.nameAr,
  }));
  return (
    <SheetContent className="w-[min(56rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <SheetTitle className="text-lg font-bold">
          {t('suppliers.linkCategory.title', { name: node.name })}
        </SheetTitle>
        <SheetClose
          render={<Button variant="ghost" size="icon-sm" aria-label={t('common.close')} />}
        >
          <XIcon />
        </SheetClose>
      </div>
      <div className="flex flex-col gap-6">
        <Field className="max-w-sm">
          <FieldLabel>{t('suppliers.linkCategory.game')}</FieldLabel>
          {games.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select items={gameItems} value={gameId} onValueChange={(value) => setGameId(value)}>
              <SelectTrigger>
                <SelectValue placeholder={t('suppliers.linkCategory.chooseGame')} />
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
        </Field>
        {gameId !== null && draft.isPending && <Skeleton className="h-64 w-full" />}
        {draft.isError && (
          <div className="flex flex-col items-start gap-3">
            <FormAlert>{errorMessage(t, draft.error)}</FormAlert>
            <Button variant="outline" onClick={() => draft.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {draft.isSuccess && gameId !== null && (
          <LinkForm key={gameId} supplier={supplier} draft={draft.data} gameId={gameId} />
        )}
      </div>
    </SheetContent>
  );
}

function LinkForm({
  supplier,
  draft: read,
  gameId,
}: {
  supplier: SupplierDetail;
  draft: ImportDraft;
  gameId: string;
}) {
  const { t } = useTranslation();
  const game = useQuery(gameQuery(gameId));
  const link = useLinkCategory(supplier.code, read.category.categoryId);
  const [entries, setEntries] = useState<FieldMapEntry[]>(() =>
    fieldMapEntries(requiredFieldsOf(read.packs), read.fieldMap),
  );
  // S16 MF3: the game's options mapped onto the supplier's, proposed by the draft.
  const [optionMap, setOptionMap] = useState<OptionMap>(read.optionMap);
  const gameFields = read.linkGame?.fields ?? [];
  const fieldMap = toFieldMap(entries);
  const selects = gameSelects(gameFields);
  // Refusals for options follow the maps as edited.
  const draft = withOptionRefusals(read, { fieldMap, optionMap, selects });
  const supplierOptions = supplierSelects(
    read.fields.map((field) => ({
      key: field.supplierKey,
      label: field.supplierLabel,
      type: field.supplierType,
      ...(field.supplierOptions && { options: field.supplierOptions }),
    })),
  );
  const optionGaps = unmappedOptions(
    read.fields.map((field) => ({
      key: field.supplierKey,
      label: field.supplierLabel,
      type: field.supplierType,
      ...(field.supplierOptions && { options: field.supplierOptions }),
    })),
    fieldMap,
    optionMap,
    selects,
  );
  const [edited, setRows] = useState<PackRow[]>(() => initialPackRows(draft));
  // The draft is read again after a refusal: what it refuses now is no longer selected.
  const rows = alignedRows(draft, edited);
  const [rowErrors, setRowErrors] = useState<Set<string>>(new Set());
  const [refusals, setRefusals] = useState<Map<string, RowRefusal>>(new Map());
  const [missing, setMissing] = useState<string[]>([]);
  const [optionMissing, setOptionMissing] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CategoryImportResult | null>(null);
  const products = (game.data?.products ?? []).filter((item) => item.archivedAt === null);
  const productItems = products.map((item) => ({ value: item.id, label: item.nameAr }));
  const sentCount = rows.filter((row) => row.selected).length;

  const setRow = (offerId: string, next: Partial<PackRow>) =>
    setRows(rows.map((row) => (row.offerId === offerId ? { ...row, ...next } : row)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setRefusals(new Map());
    setMissing([]);
    setOptionMissing([]);
    const sent = sentOffers(rows);
    const parsed = linkCategorySchema.safeParse(linkBody({ gameId, fieldMap, optionMap, rows }));
    const issues = parsed.error?.issues ?? [];
    setRowErrors(
      new Set(
        issues
          .filter((issue) => issue.path[0] === 'rows' && typeof issue.path[1] === 'number')
          .map((issue) => sent[issue.path[1] as number] ?? ''),
      ),
    );
    if (!parsed.success) {
      if (issues.some((issue) => issue.path[0] === 'fieldMap')) {
        setFailure(t('suppliers.import.errors.fieldMap'));
      } else if (issues.some((issue) => issue.path[0] === 'rows' && issue.path.length === 1)) {
        setFailure(t('suppliers.importCategory.errors.rows', { max: MAX_IMPORT_ROWS }));
      }
      return;
    }
    try {
      setResult(await link.mutateAsync(parsed.data));
    } catch (error) {
      const refused =
        error instanceof ApiError ? (error.details as { rows?: RowRefusal[] })?.rows : undefined;
      if (refused?.length) {
        setRefusals(refusalsByOffer(refused, sent));
        const named = (code: string) => [
          ...new Set(refused.filter((row) => row.code === code).flatMap((row) => row.fields ?? [])),
        ];
        setMissing(named('ROUTE_FIELDS_UNMAPPED'));
        setOptionMissing(named('FIELD_OPTIONS_DIFFER'));
        setFailure(t('suppliers.importCategory.refused'));
      } else {
        setMissing(unmappedOf(error));
        setFailure(errorMessage(t, error));
      }
    }
  }

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <Callout
          tone="info"
          icon={<CircleCheckIcon />}
          title={t('suppliers.linkCategory.done')}
          description={t('suppliers.linkCategory.doneHint', {
            routed: result.products.filter((item) => item.existing).length,
            created: result.products.filter((item) => !item.existing).length,
          })}
        />
        <Button
          variant="outline"
          className="self-start"
          render={
            <Link to="/catalog/games/$id" params={{ id: gameId }} search={{ tab: 'products' }} />
          }
        >
          {t('suppliers.importCategory.openGame')}
        </Button>
      </div>
    );
  }

  const modeItems = [
    { value: 'existing', label: t('suppliers.linkCategory.modes.existing') },
    { value: 'new', label: t('suppliers.linkCategory.modes.new') },
    { value: 'skip', label: t('suppliers.linkCategory.modes.skip') },
  ];

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <FieldMapEditor
        entries={entries}
        fields={gameFields}
        missing={missing}
        onChange={setEntries}
      />
      <OptionMapEditor
        fieldMap={fieldMap}
        fields={gameFields}
        supplierOptions={supplierOptions}
        optionMap={optionMap}
        missing={[...new Set([...optionGaps, ...optionMissing])]}
        onChange={setOptionMap}
      />
      <Section
        title={t('suppliers.linkCategory.packs', { selected: sentCount, max: MAX_IMPORT_ROWS })}
        description={t('suppliers.linkCategory.packsHint')}
      >
        {packGroups(draft.packs).map((group) => (
          <fieldset key={group.leafCategoryId} className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">
              <bdi>{group.leafName}</bdi>
            </legend>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {group.packs.map((pack) => {
                const row = rows.find((item) => item.offerId === pack.offerId) as PackRow;
                const mode = modeOf(row);
                const refusal = refusals.get(pack.offerId);
                const invalid = rowErrors.has(pack.offerId) || !!refusal;
                // At most 100 rows a link (rule SC8): once 100 are chosen, the others stay out.
                const full = !row.selected && sentCount >= MAX_IMPORT_ROWS;
                const items =
                  pack.refusal === null && !full
                    ? modeItems
                    : modeItems.filter((item) => item.value === 'skip');
                return (
                  <li key={pack.offerId} className="grid gap-3 p-3 md:grid-cols-[1fr_auto]">
                    <div className="flex flex-col gap-3">
                      <bdi className="text-sm font-medium">{pack.name}</bdi>
                      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_7rem] sm:items-start">
                        <Field>
                          <FieldLabel className="sr-only">
                            {t('suppliers.linkCategory.mode', { name: pack.name })}
                          </FieldLabel>
                          <Select
                            items={items}
                            value={mode}
                            disabled={pack.refusal !== null}
                            onValueChange={(value) =>
                              setRow(pack.offerId, {
                                selected: value !== 'skip',
                                productId:
                                  value === 'existing'
                                    ? (row.productId ??
                                      pack.match?.productId ??
                                      products[0]?.id ??
                                      null)
                                    : null,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {items.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        {mode === 'existing' && (
                          <Field invalid={invalid}>
                            <FieldLabel className="sr-only">
                              {t('suppliers.linkCategory.product', { name: pack.name })}
                            </FieldLabel>
                            <Select
                              items={productItems}
                              value={row.productId}
                              onValueChange={(value) => setRow(pack.offerId, { productId: value })}
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t('suppliers.linkCategory.chooseProduct')}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {productItems.map((item) => (
                                  <SelectItem key={item.value} value={item.value}>
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {pack.match && row.productId === pack.match.productId && (
                              <span className="text-xs text-muted-foreground">
                                {t('suppliers.linkCategory.proposed')}
                              </span>
                            )}
                            <FieldError match={invalid}>
                              {refusal
                                ? packRefusal(t, refusal)
                                : t('suppliers.importCategory.errors.pack')}
                            </FieldError>
                          </Field>
                        )}
                        {mode === 'new' && (
                          <>
                            <Field invalid={invalid}>
                              <FieldLabel className="sr-only">
                                {t('suppliers.importCategory.packName', { name: pack.name })}
                              </FieldLabel>
                              <Input
                                aria-label={t('suppliers.importCategory.packName', {
                                  name: pack.name,
                                })}
                                value={row.nameAr}
                                onChange={(event) =>
                                  setRow(pack.offerId, { nameAr: event.target.value })
                                }
                              />
                              <FieldError match={invalid}>
                                {refusal
                                  ? packRefusal(t, refusal)
                                  : t('suppliers.importCategory.errors.pack')}
                              </FieldError>
                            </Field>
                            <Field>
                              <FieldLabel className="sr-only">
                                {t('suppliers.importCategory.gameAmount')}
                              </FieldLabel>
                              <Input
                                dir="ltr"
                                inputMode="numeric"
                                aria-label={t('suppliers.importCategory.gameAmount')}
                                placeholder={t('suppliers.importCategory.gameAmount')}
                                value={row.gameAmount}
                                onChange={(event) =>
                                  setRow(pack.offerId, { gameAmount: event.target.value })
                                }
                              />
                            </Field>
                          </>
                        )}
                      </div>
                    </div>
                    <PackFacts pack={pack} />
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
      </Section>
      {failure && <FormAlert>{failure}</FormAlert>}
      <div className="sticky bottom-0 -mx-6 flex justify-end border-t border-border bg-surface px-6 py-3">
        <Button type="submit" disabled={link.isPending}>
          {link.isPending
            ? t('suppliers.linkCategory.submitting')
            : t('suppliers.linkCategory.submit', { count: sentCount })}
        </Button>
      </div>
    </form>
  );
}
