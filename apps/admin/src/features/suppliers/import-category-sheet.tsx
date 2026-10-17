import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type CatalogImage,
  type CategoryImportResult,
  formatUsd,
  type ImportDraft,
  importCategorySchema,
  MAX_IMPORT_ROWS,
  type SupplierDetail,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
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
  useFocusInvalid,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { CircleCheckIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { categoriesQuery } from '../catalog/catalog.queries';
import { ImageUpload } from '../catalog/image-upload';
import { ActivateAllButton } from './activate-all';
import {
  alignedRows,
  type FieldRow,
  importBody,
  importMaps,
  initialFieldRows,
  initialPackRows,
  type PackRow,
  packGroups,
  type RowRefusal,
  refusalsByOffer,
  sentOffers,
  withOptionRefusals,
} from './category-import';
import { OriginalPrice, StockChip } from './offer-cells';
import { categoryImageUrl, importDraftQuery, useImportCategory } from './suppliers.queries';
import { TipButton } from './tip-button';

/** The game fields the form edits (rules SC7, SC14). */
type GameKey = 'nameAr' | 'nameEn' | 'categoryId' | 'slug';

/**
 * "استيراد كلعبة جديدة" (S16 SC7, SC12–SC14, IM2): a wide sheet in three sections, the game (names,
 * store category, slug, the supplier's image or an upload), the input fields (suggested, editable,
 * the supplier's label, type and key beside each) and the packs grouped by subcategory. All or
 * nothing: refused rows show their reason in place; the game and packs are created paused.
 */
export function ImportCategorySheet({
  supplier,
  categoryId,
}: {
  supplier: SupplierDetail;
  categoryId: string;
}) {
  const { t } = useTranslation();
  const draft = useQuery(importDraftQuery(supplier.code, categoryId));
  return (
    <SheetContent className="w-[min(64rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <SheetTitle className="text-lg font-bold">
          {draft.data
            ? t('suppliers.importCategory.title', { name: draft.data.category.name })
            : t('suppliers.catalog.import')}
        </SheetTitle>
        <SheetClose
          render={<Button variant="ghost" size="icon-sm" aria-label={t('common.close')} />}
        >
          <XIcon />
        </SheetClose>
      </div>
      {draft.isPending && (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
      {draft.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, draft.error)}</FormAlert>
          <Button variant="outline" onClick={() => draft.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {draft.isSuccess && <ImportForm supplier={supplier} draft={draft.data} />}
    </SheetContent>
  );
}

function ImportForm({ supplier, draft: read }: { supplier: SupplierDetail; draft: ImportDraft }) {
  const { t } = useTranslation();
  const categories = useQuery(categoriesQuery());
  const importCategory = useImportCategory(supplier.code, read.category.categoryId);
  const [game, setGame] = useState<Record<GameKey, string>>({
    nameAr: read.game.nameAr,
    nameEn: read.game.nameEn,
    categoryId: read.game.categoryId ?? '',
    slug: read.game.slug,
  });
  const [upload, setUpload] = useState<CatalogImage | null>(null);
  // Audit A5: importing while the cover uploads would import without it.
  const [uploading, setUploading] = useState(false);
  const [useSupplierImage, setUseSupplierImage] = useState(read.category.hasImage);
  const [imageFailed, setImageFailed] = useState(false);
  const [fields, setFields] = useState<FieldRow[]>(() => initialFieldRows(read));
  // S16 MF3: a pack refused for its options is choosable once the options it lacks are removed.
  const draft = withOptionRefusals(read, importMaps(fields));
  const [edited, setRows] = useState<PackRow[]>(() => initialPackRows(draft));
  // The draft is read again after a refusal: what it refuses now is no longer selected.
  const rows = alignedRows(draft, edited);
  const [gameErrors, setGameErrors] = useState<Partial<Record<GameKey | 'cover', boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<number[]>([]);
  const [rowErrors, setRowErrors] = useState<Set<string>>(new Set());
  const [refusals, setRefusals] = useState<Map<string, RowRefusal>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CategoryImportResult | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const selected = rows.filter((row) => row.selected).length;

  const setRow = (offerId: string, next: Partial<PackRow>) =>
    setRows(rows.map((row) => (row.offerId === offerId ? { ...row, ...next } : row)));
  const setField = (index: number, next: Partial<FieldRow>) =>
    setFields((previous) => previous.map((row, at) => (at === index ? { ...row, ...next } : row)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setRefusals(new Map());
    const cover = useSupplierImage
      ? { supplierImage: true as const }
      : upload
        ? { coverFileId: upload.id }
        : null;
    const body = importBody({
      game: {
        nameAr: game.nameAr,
        nameEn: game.nameEn,
        categoryId: game.categoryId,
        slug: game.slug,
      },
      cover: cover ?? { supplierImage: true },
      fields,
      rows,
    });
    const parsed = importCategorySchema.safeParse(body);
    const issues = parsed.error?.issues ?? [];
    const sent = sentOffers(rows);
    const nextGame: Partial<Record<GameKey | 'cover', boolean>> = { cover: cover === null };
    for (const issue of issues) {
      if (issue.path[0] === 'game') nextGame[issue.path[1] as GameKey] = true;
    }
    setGameErrors(nextGame);
    setFieldErrors(
      issues.filter((issue) => issue.path[0] === 'fields').map((issue) => Number(issue.path[1])),
    );
    setRowErrors(
      new Set(
        issues
          .filter((issue) => issue.path[0] === 'rows' && typeof issue.path[1] === 'number')
          .map((issue) => sent[issue.path[1] as number] ?? ''),
      ),
    );
    if (!parsed.success || cover === null) {
      if (issues.some((issue) => issue.path[0] === 'rows' && issue.path.length === 1)) {
        setFailure(t('suppliers.importCategory.errors.rows', { max: MAX_IMPORT_ROWS }));
      }
      return focusInvalid();
    }
    try {
      setResult(await importCategory.mutateAsync(parsed.data));
    } catch (error) {
      const refused =
        error instanceof ApiError ? (error.details as { rows?: RowRefusal[] })?.rows : undefined;
      if (refused?.length) {
        setRefusals(refusalsByOffer(refused, sent));
        setFailure(t('suppliers.importCategory.refused'));
        focusInvalid();
      } else if (error instanceof ApiError && error.code === 'IMAGE_FETCH_FAILED') {
        setUseSupplierImage(false);
        setFailure(t('suppliers.importCategory.imageFailed'));
      } else {
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
          title={t('suppliers.importCategory.done')}
          description={t('suppliers.importCategory.doneHint', { count: result.products.length })}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            render={
              <Link
                to="/catalog/games/$id"
                params={{ id: result.gameId }}
                search={{ tab: 'products' }}
              />
            }
          >
            {t('suppliers.importCategory.openGame')}
          </Button>
          <ActivateAllButton gameId={result.gameId} />
        </div>
      </div>
    );
  }

  const categoryItems = (categories.data ?? [])
    .filter((item) => item.archivedAt === null)
    .map((item) => ({ value: item.id, label: item.nameAr }));
  const typeItems = (['digits', 'text'] as const).map((value) => ({
    value,
    label: t(`catalog.inputFields.types.${value}`),
  }));

  return (
    <form ref={ref} className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <Section title={t('suppliers.importCategory.sections.game')}>
        <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field invalid={gameErrors.nameAr}>
              <FieldLabel>{t('suppliers.importCategory.nameAr')}</FieldLabel>
              <Input
                name="nameAr"
                value={game.nameAr}
                onChange={(event) => setGame({ ...game, nameAr: event.target.value })}
              />
              <FieldError match={!!gameErrors.nameAr}>
                {t('suppliers.importCategory.errors.nameAr')}
              </FieldError>
            </Field>
            <Field invalid={gameErrors.nameEn}>
              <FieldLabel>{t('suppliers.importCategory.nameEn')}</FieldLabel>
              <Input
                name="nameEn"
                dir="ltr"
                value={game.nameEn}
                onChange={(event) => setGame({ ...game, nameEn: event.target.value })}
              />
              <FieldError match={!!gameErrors.nameEn}>
                {t('suppliers.importCategory.errors.nameEn')}
              </FieldError>
            </Field>
            <Field invalid={gameErrors.categoryId}>
              <FieldLabel>{t('suppliers.importCategory.storeCategory')}</FieldLabel>
              {categories.isPending ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Select
                  items={categoryItems}
                  value={game.categoryId || null}
                  onValueChange={(value) => setGame({ ...game, categoryId: value ?? '' })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('suppliers.importCategory.chooseCategory')} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FieldError match={!!gameErrors.categoryId}>
                {t('suppliers.importCategory.errors.categoryId')}
              </FieldError>
            </Field>
            <Field invalid={gameErrors.slug}>
              <FieldLabel>{t('suppliers.importCategory.slug')}</FieldLabel>
              <Input
                name="slug"
                dir="ltr"
                value={game.slug}
                onChange={(event) => setGame({ ...game, slug: event.target.value })}
              />
              <FieldError match={!!gameErrors.slug}>
                {t('suppliers.importCategory.errors.slug')}
              </FieldError>
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            {useSupplierImage ? (
              <>
                <span className="text-sm font-medium">{t('suppliers.importCategory.cover')}</span>
                <div className="flex aspect-video max-h-48 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                  {imageFailed ? (
                    <span className="p-3 text-center text-sm text-muted-foreground">
                      {t('suppliers.importCategory.previewFailed')}
                    </span>
                  ) : (
                    <img
                      src={categoryImageUrl(supplier.code, draft.category.categoryId)}
                      alt={t('suppliers.importCategory.cover')}
                      className="size-full object-contain"
                      onError={() => setImageFailed(true)}
                    />
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('suppliers.importCategory.coverHint')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => setUseSupplierImage(false)}
                >
                  {t('suppliers.importCategory.otherImage')}
                </Button>
              </>
            ) : (
              <>
                <ImageUpload
                  label={t('suppliers.importCategory.cover')}
                  hint={t('catalog.fields.coverHint')}
                  image={upload}
                  onChange={setUpload}
                  onPendingChange={setUploading}
                  error={gameErrors.cover ? t('suppliers.importCategory.errors.cover') : undefined}
                />
                {draft.category.hasImage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => setUseSupplierImage(true)}
                  >
                    {t('suppliers.importCategory.supplierImage')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </Section>

      <Section
        title={t('suppliers.importCategory.sections.fields')}
        description={t('suppliers.importCategory.fieldsHint')}
      >
        {fields.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('suppliers.importCategory.noFields')}</p>
        )}
        <ul className="flex flex-col gap-3">
          {fields.map((field, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by index.
              key={index}
              className="flex flex-col gap-3 rounded-md border border-border p-3"
              data-invalid={fieldErrors.includes(index) ? '' : undefined}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                {field.supplierKey ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {t('suppliers.importCategory.fromSupplier')}
                    <bdi className="font-medium text-foreground">
                      {draft.fields.find((item) => item.supplierKey === field.supplierKey)
                        ?.supplierLabel || field.supplierKey}
                    </bdi>
                    <bdi dir="ltr">{field.supplierKey}</bdi>
                    <Badge tone="outline">
                      {t(
                        `suppliers.offers.fieldTypes.${
                          draft.fields.find((item) => item.supplierKey === field.supplierKey)
                            ?.supplierType ?? 'text'
                        }`,
                      )}
                    </Badge>
                  </span>
                ) : (
                  <span>{t('suppliers.importCategory.ownField')}</span>
                )}
                <TipButton
                  type="button"
                  label={t('suppliers.importCategory.removeField')}
                  onClick={() => setFields((previous) => previous.filter((_, at) => at !== index))}
                >
                  <Trash2Icon />
                </TipButton>
              </div>
              {field.type === 'select' ? (
                <SelectFieldRow
                  field={field}
                  onChange={(next) => setField(index, next)}
                  required={
                    <CheckLine
                      checked={field.required}
                      onChange={(on) => setField(index, { required: on })}
                    >
                      {t('suppliers.importCategory.required')}
                    </CheckLine>
                  }
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem_5rem_5rem_auto] sm:items-end">
                  <Field>
                    <FieldLabel>{t('suppliers.importCategory.fieldKey')}</FieldLabel>
                    <Input
                      dir="ltr"
                      value={field.key}
                      onChange={(event) => setField(index, { key: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('suppliers.importCategory.fieldLabel')}</FieldLabel>
                    <Input
                      value={field.labelAr}
                      onChange={(event) => setField(index, { labelAr: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('suppliers.importCategory.fieldType')}</FieldLabel>
                    <Select
                      items={typeItems}
                      value={field.type}
                      onValueChange={(value) =>
                        setField(index, { type: (value ?? 'text') as FieldRow['type'] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {typeItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t('suppliers.importCategory.minLength')}</FieldLabel>
                    <Input
                      dir="ltr"
                      inputMode="numeric"
                      value={field.minLength}
                      onChange={(event) => setField(index, { minLength: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('suppliers.importCategory.maxLength')}</FieldLabel>
                    <Input
                      dir="ltr"
                      inputMode="numeric"
                      value={field.maxLength}
                      onChange={(event) => setField(index, { maxLength: event.target.value })}
                    />
                  </Field>
                  <CheckLine
                    checked={field.required}
                    onChange={(on) => setField(index, { required: on })}
                  >
                    {t('suppliers.importCategory.required')}
                  </CheckLine>
                </div>
              )}
              {fieldErrors.includes(index) && (
                <p role="alert" className="text-sm text-destructive-text">
                  {t('suppliers.importCategory.errors.field')}
                </p>
              )}
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            setFields((previous) => [
              ...previous,
              {
                supplierKey: null,
                key: '',
                labelAr: '',
                type: 'text',
                minLength: '1',
                maxLength: '64',
                required: true,
                options: [],
              },
            ])
          }
        >
          <PlusIcon />
          {t('suppliers.importCategory.addField')}
        </Button>
      </Section>

      <Section
        title={t('suppliers.importCategory.sections.packs', {
          selected,
          max: MAX_IMPORT_ROWS,
        })}
      >
        <PackGroups
          draft={draft}
          rows={rows}
          rowErrors={rowErrors}
          refusals={refusals}
          onRow={setRow}
          onRows={(update) => setRows(update(rows))}
        />
      </Section>

      {failure && <FormAlert>{failure}</FormAlert>}
      <InvalidAlert
        show={
          !failure &&
          (Object.values(gameErrors).some(Boolean) || fieldErrors.length > 0 || rowErrors.size > 0)
        }
      />
      <div className="sticky bottom-0 -mx-6 flex justify-end border-t border-border bg-surface px-6 py-3">
        <Button type="submit" disabled={importCategory.isPending || uploading || selected === 0}>
          {importCategory.isPending
            ? t('suppliers.importCategory.submitting')
            : t('suppliers.importCategory.submit', { count: selected })}
        </Button>
      </div>
    </form>
  );
}

/**
 * S16 MF3: a supplier select as our select: its key and label, each option's label (editable) and
 * the supplier value it is sent as; options can be removed down to S06's two.
 */
function SelectFieldRow({
  field,
  required,
  onChange,
}: {
  field: FieldRow;
  required: ReactNode;
  onChange: (next: Partial<FieldRow>) => void;
}) {
  const { t } = useTranslation();
  const setOption = (value: string, labelAr: string) =>
    onChange({
      options: field.options.map((option) =>
        option.value === value ? { ...option, labelAr } : option,
      ),
    });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field>
          <FieldLabel>{t('suppliers.importCategory.fieldKey')}</FieldLabel>
          <Input
            dir="ltr"
            value={field.key}
            onChange={(event) => onChange({ key: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel>{t('suppliers.importCategory.fieldLabel')}</FieldLabel>
          <Input
            value={field.labelAr}
            onChange={(event) => onChange({ labelAr: event.target.value })}
          />
        </Field>
        {required}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          {t('suppliers.importCategory.options')}
        </legend>
        <p className="text-xs text-muted-foreground">{t('suppliers.importCategory.optionsHint')}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {field.options.map((option) => (
            <li
              key={option.value}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2"
            >
              <Input
                aria-label={t('suppliers.importCategory.optionLabel', { value: option.value })}
                value={option.labelAr}
                onChange={(event) => setOption(option.value, event.target.value)}
              />
              <bdi dir="ltr" className="text-xs text-muted-foreground">
                {option.supplierValue ?? option.value}
              </bdi>
              <TipButton
                type="button"
                label={t('suppliers.importCategory.removeOption', { name: option.labelAr })}
                disabled={field.options.length <= 2}
                onClick={() =>
                  onChange({
                    options: field.options.filter((item) => item.value !== option.value),
                  })
                }
              >
                <XIcon />
              </TipButton>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

function CheckLine({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex h-10 cursor-pointer items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value)} />
      {children}
    </label>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-bold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The packs grouped by subcategory, with "select all" per group (SC7). */
function PackGroups({
  draft,
  rows,
  rowErrors,
  refusals,
  onRow,
  onRows,
}: {
  draft: ImportDraft;
  rows: PackRow[];
  rowErrors: Set<string>;
  refusals: Map<string, RowRefusal>;
  onRow: (offerId: string, next: Partial<PackRow>) => void;
  onRows: (update: (rows: PackRow[]) => PackRow[]) => void;
}) {
  const { t } = useTranslation();
  const byOffer = new Map(rows.map((row) => [row.offerId, row]));
  const selected = rows.filter((row) => row.selected).length;
  return (
    <div className="flex flex-col gap-4">
      {packGroups(draft.packs).map((group) => {
        const choosable = group.packs.filter((pack) => pack.refusal === null);
        const all =
          choosable.length > 0 && choosable.every((pack) => byOffer.get(pack.offerId)?.selected);
        return (
          <fieldset key={group.leafCategoryId} className="flex flex-col gap-2">
            <legend className="mb-1 flex w-full items-center gap-2">
              <Checkbox
                aria-label={t('suppliers.importCategory.selectGroup', { name: group.leafName })}
                checked={all}
                disabled={choosable.length === 0}
                onCheckedChange={(on) =>
                  onRows((previous) => {
                    let count = previous.filter((row) => row.selected).length;
                    const ids = new Set(choosable.map((pack) => pack.offerId));
                    return previous.map((row) => {
                      if (!ids.has(row.offerId) || row.selected === on) return row;
                      if (on && count >= MAX_IMPORT_ROWS) return row;
                      count += on ? 1 : -1;
                      return { ...row, selected: on };
                    });
                  })
                }
              />
              <bdi className="font-medium">{group.leafName}</bdi>
              <span className="text-sm text-muted-foreground">
                {t('suppliers.importCategory.groupCount', { count: group.packs.length })}
              </span>
            </legend>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {group.packs.map((pack) => {
                const row = byOffer.get(pack.offerId) as PackRow;
                const refusal = refusals.get(pack.offerId);
                const invalid = rowErrors.has(pack.offerId) || !!refusal;
                return (
                  <li
                    key={pack.offerId}
                    className="grid gap-3 p-3 md:grid-cols-[auto_1fr_7rem_auto] md:items-start"
                  >
                    <Checkbox
                      className="mt-2"
                      aria-label={t('suppliers.importCategory.selectPack', { name: pack.name })}
                      checked={row.selected}
                      disabled={
                        pack.refusal !== null || (!row.selected && selected >= MAX_IMPORT_ROWS)
                      }
                      onCheckedChange={(on) => onRow(pack.offerId, { selected: on })}
                    />
                    <Field invalid={invalid}>
                      <FieldLabel className="text-sm font-normal text-muted-foreground">
                        <bdi>{pack.name}</bdi>
                      </FieldLabel>
                      <Input
                        value={row.nameAr}
                        disabled={pack.refusal !== null}
                        onChange={(event) => onRow(pack.offerId, { nameAr: event.target.value })}
                      />
                      <FieldError match={invalid}>
                        {refusal
                          ? packRefusal(t, refusal)
                          : t('suppliers.importCategory.errors.pack')}
                      </FieldError>
                    </Field>
                    <Field>
                      <FieldLabel className="text-sm font-normal text-muted-foreground">
                        {t('suppliers.importCategory.gameAmount')}
                      </FieldLabel>
                      <Input
                        dir="ltr"
                        inputMode="numeric"
                        value={row.gameAmount}
                        disabled={pack.refusal !== null}
                        onChange={(event) =>
                          onRow(pack.offerId, { gameAmount: event.target.value })
                        }
                      />
                    </Field>
                    <PackFacts pack={pack} />
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

/** A pack's cost, original price and discount, stock, the price the store would charge (SF1). */
export function PackFacts({ pack }: { pack: ImportDraft['packs'][number] }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:min-w-56">
      <dt className="text-muted-foreground">{t('suppliers.importCategory.cost')}</dt>
      <dd className="flex flex-col gap-0.5">
        <bdi dir="ltr" className="font-medium tabular-nums">
          {pack.costUsdUnits === null ? '—' : formatUsd(pack.costUsdUnits)}
        </bdi>
        <OriginalPrice
          originalCostUsdUnits={pack.originalCostUsdUnits}
          discountPercent={pack.discountPercent}
        />
      </dd>
      <dt className="text-muted-foreground">{t('suppliers.importCategory.price')}</dt>
      <dd>
        <bdi dir="ltr" className="font-medium tabular-nums">
          {pack.pricePreviewUsdUnits === null ? '—' : formatUsd(pack.pricePreviewUsdUnits)}
        </bdi>
      </dd>
      <dt className="text-muted-foreground">{t('suppliers.offers.columns.stock')}</dt>
      <dd>
        <StockChip level={pack.stockLevel} stock={pack.stock} />
      </dd>
      {pack.refusal && (
        <dd className="col-span-2">
          <Badge tone="danger">{t(`suppliers.importCategory.refusals.${pack.refusal}`)}</Badge>
        </dd>
      )}
    </dl>
  );
}

/** A refused row's code in words, with the supplier fields left unmapped (rule RT3). */
export function packRefusal(t: TFunction, refusal: RowRefusal): string {
  const message = errorMessage(t, new ApiError(409, refusal.code, undefined, refusal.code));
  return refusal.fields?.length ? `${message} (${refusal.fields.join('، ')})` : message;
}
