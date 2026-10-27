import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  PRICE_LIST_MAX_DEPTH,
  type PriceList,
  priceListNameSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ListIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { Picker } from './picker';
import {
  priceListsQuery,
  useArchivePriceList,
  useCreatePriceList,
  useRenamePriceList,
} from './pricing.queries';

/** The kinds' badge tones: the roots apart from the custom lists. */
const KIND_TONES = { retail: 'brand', wholesale: 'gold', cost: 'info', custom: 'neutral' } as const;

export function KindBadge({ kind }: { kind: PriceList['kind'] }) {
  const { t } = useTranslation();
  return <Badge tone={KIND_TONES[kind]}>{t(`pricing.lists.kinds.${kind}`)}</Badge>;
}

/**
 * "قوائم الأسعار" (S20 LS1–LS6): the three roots and the custom lists with their parent, the
 * accounts assigned, their rules, fixed prices and fallback cells; create, rename and archive,
 * each re-authenticated. Archived lists are shown on request.
 */
export function PriceListsPage() {
  const { t } = useTranslation();
  const lists = useQuery(priceListsQuery);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<PriceList | null>(null);
  const [archiving, setArchiving] = useState<PriceList | null>(null);
  const archive = useArchivePriceList();
  const archivedId = useId();

  const shown = (lists.data ?? []).filter((list) => showArchived || list.archivedAt === null);
  const nameOf = (id: string | null) => lists.data?.find((list) => list.id === id)?.name ?? '';

  return (
    <>
      <PageHeader
        title={t('pricing.lists.title')}
        description={t('pricing.lists.subtitle')}
        actions={
          <Button onClick={() => setCreating(true)} disabled={!lists.isSuccess}>
            {t('pricing.lists.create')}
          </Button>
        }
      />
      {lists.isPending && <Skeleton className="h-64 w-full" aria-hidden="true" />}
      {lists.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, lists.error)}</FormAlert>
          <Button variant="outline" onClick={() => lists.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {lists.isSuccess && (
        <div className="flex flex-col gap-3">
          <label htmlFor={archivedId} className="flex items-center gap-2 self-end text-sm">
            <Switch id={archivedId} checked={showArchived} onCheckedChange={setShowArchived} />
            {t('pricing.lists.showArchived')}
          </label>
          {shown.length === 0 ? (
            <EmptyState icon={<ListIcon />} title={t('pricing.lists.empty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('pricing.lists.columns.name')}</TableHead>
                  <TableHead>{t('pricing.lists.columns.parent')}</TableHead>
                  <TableHead>{t('pricing.lists.columns.accounts')}</TableHead>
                  <TableHead>{t('pricing.lists.columns.rules')}</TableHead>
                  <TableHead>{t('pricing.lists.columns.fixedPrices')}</TableHead>
                  <TableHead>{t('pricing.lists.columns.fallbacks')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('pricing.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((list) => (
                  <TableRow key={list.id} className={list.archivedAt ? 'opacity-60' : undefined}>
                    <TableCell className="whitespace-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/pricing/lists/$id"
                          params={{ id: list.id }}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {list.name}
                        </Link>
                        <KindBadge kind={list.kind} />
                        {list.archivedAt && (
                          <Badge tone="outline">{t('pricing.lists.archived')}</Badge>
                        )}
                        {!list.ready && <Badge tone="warning">{t('pricing.lists.notReady')}</Badge>}
                      </span>
                    </TableCell>
                    <TableCell>{list.parentListId ? nameOf(list.parentListId) : '—'}</TableCell>
                    <TableCell className="tabular-nums">{list.accounts}</TableCell>
                    <TableCell className="tabular-nums">{list.rules}</TableCell>
                    <TableCell className="tabular-nums">{list.fixedPrices}</TableCell>
                    <TableCell className="tabular-nums">
                      {list.fallbackCells > 0 ? (
                        <Badge tone="warning">{list.fallbackCells}</Badge>
                      ) : (
                        0
                      )}
                    </TableCell>
                    <TableCell>
                      {!list.archivedAt && (
                        <span className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setRenaming(list)}>
                            {t('pricing.lists.rename')}
                          </Button>
                          {list.kind === 'custom' && (
                            <Button variant="ghost" size="sm" onClick={() => setArchiving(list)}>
                              {t('pricing.actions.archive')}
                            </Button>
                          )}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && lists.data && (
          <ListNameDialog
            // A child sits one level below its parent: lists at the depth limit take none (A05-41).
            parents={lists.data.filter(
              (list) =>
                list.archivedAt === null && list.ready && list.chain.length < PRICE_LIST_MAX_DEPTH,
            )}
            onDone={() => setCreating(false)}
          />
        )}
      </Dialog>
      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        {renaming && <ListNameDialog list={renaming} onDone={() => setRenaming(null)} />}
      </Dialog>
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title={t('pricing.lists.archiveTitle')}
        body={t('pricing.lists.archiveBody', { name: archiving?.name ?? '' })}
        action={t('pricing.actions.archive')}
        destructive
        pending={archive.isPending}
        onConfirm={async () => {
          if (archiving) await archive.mutateAsync(archiving.id);
        }}
        describeFailure={(error) => {
          if (!(error instanceof ApiError) || error.code !== 'PRICE_LIST_IN_USE') return undefined;
          // S21 LV6: a merchant level may hold the list too (audit A05-40).
          const details = error.details as { accounts: number; children: number; levels?: number };
          return t('pricing.lists.inUse', { levels: 0, ...details });
        }}
      />
    </>
  );
}

/** Creates a custom list under a parent, or renames a list (LS1, LS3). */
function ListNameDialog({
  list,
  parents = [],
  onDone,
}: {
  /** The list to rename; absent to create one. */
  list?: PriceList;
  parents?: PriceList[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreatePriceList();
  const rename = useRenamePriceList();
  const [name, setName] = useState(list?.name ?? '');
  const [parentId, setParentId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<'name' | 'taken' | 'parent' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const pending = create.isPending || rename.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = priceListNameSchema.safeParse(name);
    if (!parsed.success) {
      setInvalid('name');
      return focusInvalid();
    }
    if (!list && !parentId) {
      setInvalid('parent');
      return focusInvalid();
    }
    setInvalid(null);
    try {
      if (list) await rename.mutateAsync({ id: list.id, name: parsed.data });
      else await create.mutateAsync({ name: parsed.data, parentListId: parentId as string });
      onDone();
    } catch (error) {
      // A taken name is said under the name field (audit A05-41).
      if (error instanceof ApiError && error.code === 'PRICE_LIST_NAME_TAKEN') {
        setInvalid('taken');
        return focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>
          {list ? t('pricing.lists.renameTitle') : t('pricing.lists.create')}
        </DialogTitle>
        <DialogDescription>
          {list ? t('pricing.lists.renameHint') : t('pricing.lists.createHint')}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={invalid === 'name' || invalid === 'taken'}>
          <FieldLabel>{t('pricing.lists.columns.name')}</FieldLabel>
          <Input
            name="name"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldError match={invalid === 'name'}>{t('pricing.lists.nameInvalid')}</FieldError>
          <FieldError match={invalid === 'taken'}>
            {t('errors.api.PRICE_LIST_NAME_TAKEN')}
          </FieldError>
        </Field>
        {!list && (
          <Field invalid={invalid === 'parent'}>
            <FieldLabel render={<span />}>{t('pricing.lists.columns.parent')}</FieldLabel>
            <Picker
              label={t('pricing.lists.columns.parent')}
              placeholder={t('pricing.calculator.choose')}
              items={parents.map((parent) => ({ value: parent.id, label: parent.name }))}
              value={parentId}
              onChange={setParentId}
            />
            <FieldError match={invalid === 'parent'}>
              {t('pricing.lists.parentRequired')}
            </FieldError>
          </Field>
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? t('pricing.form.saving') : t('pricing.lists.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
