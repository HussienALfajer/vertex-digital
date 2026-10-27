import { useQuery } from '@tanstack/react-query';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import {
  ACCENT_DARK_SURFACE,
  ACCENT_LIGHT_SURFACE,
  ACCENT_MIN_CONTRAST,
  type CatalogImage,
  contrastRatio,
  createGameSchema,
  type GameDetail,
  updateGameSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { SupplierCoverButton } from '../suppliers/game-supplier-links';
import { categoriesQuery, useCreateGame, useUpdateGame } from './catalog.queries';
import { catalogFailure } from './catalog-parts';
import { ImageUpload } from './image-upload';
import { SearchTermsField } from './search-terms-field';

const GAME_FIELDS = [
  'nameAr',
  'nameEn',
  'slug',
  'categoryId',
  'accentColor',
  'regionNotesAr',
] as const;

type GameField = (typeof GAME_FIELDS)[number];

type GameErrors = Partial<Record<GameField | 'cover' | 'idGuide' | 'searchTerms', string>>;

const FIELD_OF_CODE: Partial<Record<string, GameField>> = {
  SLUG_TAKEN: 'slug',
  NAME_TAKEN: 'nameAr',
  PARENT_ARCHIVED: 'categoryId',
  ACCENT_CONTRAST_TOO_LOW: 'accentColor',
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * "البيانات" (S06 screens): names, slug (fixed once created: the page address), category, the
 * cover and ID guide images, the accent color with both contrast ratios live (rule CT6), the
 * region notes and, for a saved game, its search terms (S09 rule AD1) and status (rule CT3).
 */
export function GameForm({ game, categoryId }: { game?: GameDetail; categoryId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const categories = useQuery(categoriesQuery());
  const create = useCreateGame();
  const update = useUpdateGame(game?.id ?? '');
  const [category, setCategory] = useState<string | null>(game?.categoryId ?? categoryId ?? null);
  const [cover, setCover] = useState<CatalogImage | null>(game?.cover ?? null);
  const [idGuide, setIdGuide] = useState<CatalogImage | null>(game?.idGuide ?? null);
  const [accent, setAccent] = useState(game?.accentColor ?? '');
  const [searchTerms, setSearchTerms] = useState<string[]>(game?.searchTerms ?? []);
  const [errors, setErrors] = useState<GameErrors>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Audit A5: saving while an image uploads would save the image it is replacing.
  const [coverUploading, setCoverUploading] = useState(false);
  const [idGuideUploading, setIdGuideUploading] = useState(false);
  const [supplierCoverPending, setSupplierCoverPending] = useState(false);
  const pending =
    create.isPending ||
    update.isPending ||
    coverUploading ||
    idGuideUploading ||
    supplierCoverPending;
  // Audit A03-12: what was typed is kept across the tabs (the panel stays mounted) and leaving
  // the page asks first. A ref, so a save's own navigation reads it at once.
  const dirty = useRef(false);
  const touch = () => {
    dirty.current = true;
  };
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      touch();
    };
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirty.current,
    withResolver: true,
  });

  const items = (categories.data ?? []).map((item) => ({ value: item.id, label: item.nameAr }));
  // A game in an archived category still shows it, though it cannot be picked again (only once
  // the list is read: before, every category would read as archived, audit A03-14).
  if (game && categories.isSuccess && !items.some((item) => item.value === game.categoryId)) {
    items.push({ value: game.categoryId, label: t('catalog.game.archivedCategoryName') });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const values = {
      categoryId: category,
      nameAr: text('nameAr'),
      nameEn: text('nameEn'),
      coverFileId: cover?.id ?? null,
      idGuideFileId: idGuide?.id ?? null,
      accentColor: accent.trim() || null,
      regionNotesAr: text('regionNotesAr') || null,
    };
    const parsed = game
      ? updateGameSchema.safeParse({ ...values, searchTerms })
      : createGameSchema.safeParse({ ...values, slug: text('slug') });
    const found: GameErrors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = String(issue.path[0]);
      if ((GAME_FIELDS as readonly string[]).includes(field)) {
        found[field as GameField] = t(`catalog.game.errors.${field as GameField}`);
      }
      if (field === 'searchTerms') found.searchTerms = t('catalog.searchTerms.invalid');
    }
    setErrors(found);
    if (!parsed.success) return focusInvalid();
    try {
      if (game) {
        await update.mutateAsync(parsed.data);
        dirty.current = false;
        setSaved(true);
      } else {
        const created = await create.mutateAsync(
          parsed.data as Parameters<typeof create.mutateAsync>[0],
        );
        dirty.current = false;
        await navigate({ to: '/catalog/games/$id', params: { id: created.id } });
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const field = code ? FIELD_OF_CODE[code] : undefined;
      const missing =
        error instanceof ApiError && code === 'CATALOG_INCOMPLETE'
          ? (error.details as { missing?: string[] } | undefined)?.missing
          : undefined;
      if (missing?.includes('cover')) {
        // An active game keeps its cover (rule CT3), said where the cover is (audit A03-13).
        setErrors({ cover: t('catalog.game.coverRequired') });
      } else if (code === 'ACCENT_CONTRAST_TOO_LOW' && error instanceof ApiError) {
        const ratio = (error.details as { ratio?: unknown } | undefined)?.ratio;
        setErrors({
          accentColor: t('catalog.game.accentRefused', { ratio: ltr(`${String(ratio)}:1`) }),
        });
      } else if (field) {
        setErrors({ [field]: errorMessage(t, error) });
      } else if (code === 'VALIDATION_FAILED' && refusesSearchTerms(error)) {
        setErrors({ searchTerms: t('catalog.searchTerms.invalid') });
      } else {
        return setFailure(catalogFailure(t, error));
      }
      focusInvalid();
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Card>
        <form
          ref={ref}
          className="flex flex-col gap-5"
          onSubmit={submit}
          onChange={touch}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field invalid={!!errors.nameAr}>
              <FieldLabel>{t('catalog.fields.nameAr')}</FieldLabel>
              <Input name="nameAr" defaultValue={game?.nameAr} maxLength={60} autoComplete="off" />
              <FieldError match={!!errors.nameAr}>{errors.nameAr}</FieldError>
            </Field>
            <Field invalid={!!errors.nameEn}>
              <FieldLabel>{t('catalog.fields.nameEn')}</FieldLabel>
              <Input
                name="nameEn"
                defaultValue={game?.nameEn}
                dir="ltr"
                maxLength={60}
                autoComplete="off"
              />
              <FieldError match={!!errors.nameEn}>{errors.nameEn}</FieldError>
            </Field>
            <Field invalid={!!errors.slug}>
              <FieldLabel>{t('catalog.fields.slug')}</FieldLabel>
              <Input
                name="slug"
                defaultValue={game?.slug}
                readOnly={!!game}
                dir="ltr"
                maxLength={48}
                autoComplete="off"
                spellCheck={false}
              />
              <FieldDescription>
                {game ? t('catalog.fields.slugFixed') : t('catalog.fields.slugHint')}
              </FieldDescription>
              <FieldError match={!!errors.slug}>{errors.slug}</FieldError>
            </Field>
            <Field invalid={!!errors.categoryId}>
              <FieldLabel render={<span />}>{t('catalog.fields.category')}</FieldLabel>
              {categories.isPending ? (
                <Skeleton className="h-8 w-full" />
              ) : categories.isError ? (
                <div className="flex flex-col items-start gap-2">
                  <FormAlert>{errorMessage(t, categories.error)}</FormAlert>
                  <Button variant="outline" size="sm" onClick={() => void categories.refetch()}>
                    {t('common.retry')}
                  </Button>
                </div>
              ) : (
                <Select items={items} value={category} onValueChange={changed(setCategory)}>
                  <SelectTrigger aria-label={t('catalog.fields.category')}>
                    <SelectValue placeholder={t('catalog.fields.chooseCategory')} />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {game && <FieldDescription>{t('catalog.fields.categoryMove')}</FieldDescription>}
              <FieldError match={!!errors.categoryId}>{errors.categoryId}</FieldError>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <ImageUpload
                label={t('catalog.fields.cover')}
                hint={t('catalog.fields.coverHint')}
                image={cover}
                onChange={changed(setCover)}
                onPendingChange={setCoverUploading}
                error={errors.cover}
              />
              {game && (
                <SupplierCoverButton
                  gameId={game.id}
                  onCover={setCover}
                  onPendingChange={setSupplierCoverPending}
                />
              )}
            </div>
            <ImageUpload
              label={t('catalog.fields.idGuide')}
              hint={t('catalog.fields.idGuideHint')}
              image={idGuide}
              onChange={changed(setIdGuide)}
              onPendingChange={setIdGuideUploading}
            />
          </div>
          <AccentField value={accent} onChange={changed(setAccent)} error={errors.accentColor} />
          <Field invalid={!!errors.regionNotesAr}>
            <FieldLabel>{t('catalog.fields.regionNotes')}</FieldLabel>
            <Textarea
              name="regionNotesAr"
              defaultValue={game?.regionNotesAr ?? ''}
              rows={3}
              maxLength={500}
            />
            <FieldDescription>{t('catalog.fields.regionNotesHint')}</FieldDescription>
            <FieldError match={!!errors.regionNotesAr}>{errors.regionNotesAr}</FieldError>
          </Field>
          {game && (
            <SearchTermsField
              terms={searchTerms}
              onChange={changed(setSearchTerms)}
              error={errors.searchTerms}
            />
          )}
          {failure && <FormAlert>{failure}</FormAlert>}
          <InvalidAlert show={Object.values(errors).some(Boolean)} />
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('catalog.game.saved')}
            </p>
          )}
          <Button type="submit" className="self-start" disabled={pending}>
            {game ? t('catalog.game.save') : t('catalog.game.create')}
          </Button>
        </form>
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title={t('catalog.game.leave.title')}
          body={t('catalog.game.leave.body')}
          action={t('catalog.game.leave.leave')}
          destructive
          pending={false}
          onConfirm={async () => blocker.proceed?.()}
        />
      </Card>
      <div className="flex flex-col gap-6">
        {game ? (
          <>
            <StatusCard game={game} />
            <BestValueCard game={game} />
          </>
        ) : (
          <Card>
            <p className="text-sm text-muted-foreground">{t('catalog.game.startsPaused')}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

/** A `VALIDATION_FAILED` whose issues name the search terms (rule AD1). */
function refusesSearchTerms(error: unknown): boolean {
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    Array.isArray(details) &&
    details.some(
      (issue: { path?: unknown }) => Array.isArray(issue.path) && issue.path[0] === 'searchTerms',
    )
  );
}

/** Rule CT6: refused under 3:1 against the dark surface, a warning under 3:1 against white. */
function AccentField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const pickerId = useId();
  const valid = HEX.test(value.trim());
  const dark = valid ? contrastRatio(value.trim(), ACCENT_DARK_SURFACE) : null;
  const light = valid ? contrastRatio(value.trim(), ACCENT_LIGHT_SURFACE) : null;
  return (
    <Field invalid={!!error || (dark !== null && dark < ACCENT_MIN_CONTRAST)}>
      <FieldLabel>{t('catalog.fields.accent')}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          name="accentColor"
          dir="ltr"
          className="w-32"
          maxLength={7}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('catalog.fields.accentPlaceholder')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <label htmlFor={pickerId} className="sr-only">
          {t('catalog.fields.accentPicker')}
        </label>
        <input
          id={pickerId}
          type="color"
          className="h-9 w-12 cursor-pointer rounded-md border border-border bg-surface"
          // Without a valid color the picker opens on the dark surface it is checked against.
          value={valid ? value.trim() : ACCENT_DARK_SURFACE}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            {t('catalog.fields.accentClear')}
          </Button>
        )}
      </div>
      {dark !== null && light !== null ? (
        <div className="flex flex-col gap-1 text-sm" aria-live="polite">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex h-6 items-center rounded-sm px-2 text-xs font-bold"
              style={{ backgroundColor: ACCENT_DARK_SURFACE, color: value.trim() }}
            >
              Aa
            </span>
            {dark < ACCENT_MIN_CONTRAST
              ? t('catalog.game.contrastDarkRefused', { ratio: ltr(`${dark}:1`) })
              : t('catalog.game.contrastDark', { ratio: ltr(`${dark}:1`) })}
          </span>
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex h-6 items-center rounded-sm border border-border px-2 text-xs font-bold"
              style={{ backgroundColor: ACCENT_LIGHT_SURFACE, color: value.trim() }}
            >
              Aa
            </span>
            {light < ACCENT_MIN_CONTRAST
              ? t('catalog.game.contrastLightWarning', { ratio: ltr(`${light}:1`) })
              : t('catalog.game.contrastLight', { ratio: ltr(`${light}:1`) })}
          </span>
        </div>
      ) : (
        <FieldDescription>{t('catalog.fields.accentHint')}</FieldDescription>
      )}
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}

/** The status toggle (rules CT3, CT4): takes effect at once; refusals name what is missing. */
function StatusCard({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const update = useUpdateGame(game.id);
  const switchId = useId();
  const [failure, setFailure] = useState<string | null>(null);

  async function change(active: boolean) {
    setFailure(null);
    try {
      await update.mutateAsync({ status: active ? 'active' : 'paused' });
    } catch (error) {
      setFailure(catalogFailure(t, error));
    }
  }

  return (
    <Card className="gap-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-base font-medium">
          {t('catalog.game.active')}
        </label>
        <Switch
          id={switchId}
          checked={game.status === 'active'}
          disabled={update.isPending || game.archivedAt !== null}
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {game.status === 'active' ? t('catalog.game.activeHint') : t('catalog.game.pausedHint')}
      </p>
      {failure && <FormAlert>{failure}</FormAlert>}
    </Card>
  );
}

/** S22 BV1: "شارة أفضل قيمة" and the per-100 prices on the game page; takes effect at once. */
function BestValueCard({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const update = useUpdateGame(game.id);
  const switchId = useId();
  const [failure, setFailure] = useState<string | null>(null);

  async function change(bestValueEnabled: boolean) {
    setFailure(null);
    try {
      await update.mutateAsync({ bestValueEnabled });
    } catch (error) {
      setFailure(catalogFailure(t, error));
    }
  }

  return (
    <Card className="gap-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-base font-medium">
          {t('catalog.game.bestValue')}
        </label>
        <Switch
          id={switchId}
          checked={game.bestValueEnabled}
          disabled={update.isPending || game.archivedAt !== null}
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t('catalog.game.bestValueHint')}</p>
      {failure && <FormAlert>{failure}</FormAlert>}
    </Card>
  );
}
