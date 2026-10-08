import { useQuery } from '@tanstack/react-query';
import {
  type Category,
  createCategorySchema,
  updateCategorySchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import {
  categoriesQuery,
  useArchiveCategory,
  useCreateCategory,
  useRenameCategory,
  useReorderCategories,
} from './catalog.queries';
import { catalogFailure, MoveButton } from './catalog-parts';
import { moved } from './catalog-search';

/**
 * "إدارة الفئات" (S06 screens): the categories with rename, order, archive and restore, and a new
 * category. Archiving a category that still holds games names them (rule CT2).
 */
export function CategoriesDialog() {
  const { t } = useTranslation();
  const [archived, setArchived] = useState(false);
  const categories = useQuery(categoriesQuery(archived));
  const reorder = useReorderCategories();
  const archive = useArchiveCategory();
  const [failure, setFailure] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<Category | null>(null);
  const items = categories.data ?? [];

  async function run(action: () => Promise<unknown>) {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('catalog.categories.title')}</DialogTitle>
        <DialogDescription>{t('catalog.categories.description')}</DialogDescription>
      </DialogHeader>
      <Tabs
        value={archived ? 'archived' : 'live'}
        onValueChange={(value) => setArchived(value === 'archived')}
      >
        <TabsList>
          <TabsTrigger value="live">{t('catalog.filters.live')}</TabsTrigger>
          <TabsTrigger value="archived">{t('catalog.filters.archived')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {categories.isPending && <Skeleton className="h-32 w-full" aria-hidden="true" />}
      {categories.isError && <FormAlert>{errorMessage(t, categories.error)}</FormAlert>}
      {categories.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {archived ? t('catalog.categories.noneArchived') : t('catalog.categories.none')}
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {items.map((category, index) => (
            <li key={category.id} className="flex flex-wrap items-center gap-3 p-3">
              <CategoryName category={category} editable={!archived} />
              <span className="text-sm text-muted-foreground">
                {t('catalog.categories.games', { count: category.gameCount })}
              </span>
              <span className="ms-auto flex items-center gap-1">
                {!archived && (
                  <>
                    <MoveButton
                      label={t('catalog.order.up', { name: category.nameAr })}
                      disabled={reorder.isPending}
                      onClick={
                        index > 0
                          ? () =>
                              run(() =>
                                reorder.mutateAsync(
                                  moved(
                                    items.map((item) => item.id),
                                    index,
                                    -1,
                                  ),
                                ),
                              )
                          : undefined
                      }
                    >
                      <ArrowUpIcon />
                    </MoveButton>
                    <MoveButton
                      label={t('catalog.order.down', { name: category.nameAr })}
                      disabled={reorder.isPending}
                      onClick={
                        index < items.length - 1
                          ? () =>
                              run(() =>
                                reorder.mutateAsync(
                                  moved(
                                    items.map((item) => item.id),
                                    index,
                                    1,
                                  ),
                                ),
                              )
                          : undefined
                      }
                    >
                      <ArrowDownIcon />
                    </MoveButton>
                  </>
                )}
                {archived ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={archive.isPending}
                    onClick={() =>
                      run(() => archive.mutateAsync({ id: category.id, archive: false }))
                    }
                  >
                    {t('catalog.actions.restore')}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setArchiving(category)}>
                    {t('catalog.actions.archive')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      {!archived && <NewCategoryForm />}
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title={t('catalog.categories.archiveTitle')}
        body={t('catalog.categories.archiveBody', { name: archiving?.nameAr ?? '' })}
        action={t('catalog.actions.archive')}
        destructive
        pending={archive.isPending}
        describeFailure={(error) => catalogFailure(t, error)}
        onConfirm={async () => {
          if (archiving) await archive.mutateAsync({ id: archiving.id, archive: true });
        }}
      />
    </DialogContent>
  );
}

/** The name, renamed in place. */
function CategoryName({ category, editable }: { category: Category; editable: boolean }) {
  const { t } = useTranslation();
  const rename = useRenameCategory();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = updateCategorySchema.safeParse({
      nameAr: new FormData(event.currentTarget).get('nameAr'),
    });
    if (!parsed.success) return setError(t('catalog.categories.errors.name'));
    try {
      await rename.mutateAsync({ id: category.id, nameAr: parsed.data.nameAr });
      setEditing(false);
      setError(null);
    } catch (failure) {
      setError(errorMessage(t, failure));
    }
  }

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-medium">{category.nameAr}</span>
        <span dir="ltr" className="text-sm text-muted-foreground">
          {category.slug}
        </span>
        {editable && (
          <Button variant="link" size="sm" onClick={() => setEditing(true)}>
            {t('catalog.actions.rename')}
          </Button>
        )}
      </span>
    );
  }
  return (
    <form className="flex items-start gap-2" onSubmit={submit} noValidate>
      <Field invalid={!!error}>
        <FieldLabel className="sr-only">{t('catalog.categories.name')}</FieldLabel>
        <Input name="nameAr" defaultValue={category.nameAr} maxLength={40} autoFocus />
        <FieldError match={!!error}>{error}</FieldError>
      </Field>
      <Button type="submit" size="sm" disabled={rename.isPending}>
        {t('catalog.actions.save')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
        {t('common.cancel')}
      </Button>
    </form>
  );
}

function NewCategoryForm() {
  const { t } = useTranslation();
  const create = useCreateCategory();
  const [errors, setErrors] = useState<{ slug?: string; nameAr?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = createCategorySchema.safeParse({
      slug: data.get('slug'),
      nameAr: data.get('nameAr'),
    });
    const found: typeof errors = {};
    for (const issue of parsed.error?.issues ?? []) {
      if (issue.path[0] === 'slug') found.slug = t('catalog.errors.slug');
      if (issue.path[0] === 'nameAr') found.nameAr = t('catalog.categories.errors.name');
    }
    setErrors(found);
    if (!parsed.success) return;
    try {
      await create.mutateAsync(parsed.data);
      form.reset();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'SLUG_TAKEN') setErrors({ slug: errorMessage(t, error) });
      else if (code === 'NAME_TAKEN') setErrors({ nameAr: errorMessage(t, error) });
      else setFailure(errorMessage(t, error));
    }
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-lg bg-muted p-4"
      onSubmit={submit}
      noValidate
      aria-labelledby="new-category"
    >
      <h3 id="new-category" className="text-base font-bold">
        {t('catalog.categories.add')}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field invalid={!!errors.nameAr}>
          <FieldLabel>{t('catalog.categories.name')}</FieldLabel>
          <Input name="nameAr" maxLength={40} autoComplete="off" />
          <FieldError match={!!errors.nameAr}>{errors.nameAr}</FieldError>
        </Field>
        <Field invalid={!!errors.slug}>
          <FieldLabel>{t('catalog.fields.slug')}</FieldLabel>
          <Input name="slug" dir="ltr" maxLength={48} autoComplete="off" spellCheck={false} />
          <FieldDescription>{t('catalog.fields.slugHint')}</FieldDescription>
          <FieldError match={!!errors.slug}>{errors.slug}</FieldError>
        </Field>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      <Button type="submit" className="self-start" disabled={create.isPending}>
        {t('catalog.categories.addSubmit')}
      </Button>
    </form>
  );
}
