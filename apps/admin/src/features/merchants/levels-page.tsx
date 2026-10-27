import { useQuery } from '@tanstack/react-query';
import {
  formatAmountInput,
  formatUsd,
  MERCHANT_LEVELS_MAX,
  type MerchantLevel,
  merchantLevelInputSchema,
  parseUsd,
  ROOT_PRICE_LIST_IDS,
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
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArchiveIcon, CircleAlertIcon, MedalIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { Picker } from '../pricing/picker';
import { priceListsQuery } from '../pricing/pricing.queries';
import {
  merchantLevelsQuery,
  useArchiveMerchantLevel,
  useCreateMerchantLevel,
  useUpdateMerchantLevel,
} from './merchants.queries';

/**
 * "مستويات التجّار" (S21 F39, LV1, LV6): the volume levels with their monthly threshold, list and
 * merchants; add, edit and archive, each re-authenticated. A level's list is wholesale or a custom
 * list; every change recomputes every merchant.
 */
export function MerchantLevelsPage() {
  const { t } = useTranslation();
  const levels = useQuery(merchantLevelsQuery);
  const [editing, setEditing] = useState<MerchantLevel | 'new' | null>(null);
  const [archiving, setArchiving] = useState<MerchantLevel | null>(null);
  const archive = useArchiveMerchantLevel();
  const live = levels.data?.items.filter((level) => level.archivedAt === null) ?? [];
  const archived = levels.data?.items.filter((level) => level.archivedAt !== null) ?? [];
  // LV1: at most 10 live levels; the button says so before the dialog is filled (audit A06-51).
  const full = live.length >= MERCHANT_LEVELS_MAX;

  return (
    <>
      <PageHeader
        title={t('merchants.levels.title')}
        description={t('merchants.levels.subtitle')}
        actions={
          <Button
            disabled={full}
            aria-describedby={full ? 'levels-full' : undefined}
            onClick={() => setEditing('new')}
          >
            <PlusIcon />
            {t('merchants.levels.add')}
          </Button>
        }
      />
      <p className="text-muted-foreground text-sm">{t('merchants.levels.note')}</p>
      {full && (
        <p id="levels-full" className="text-sm text-status-warning-foreground">
          {t('merchants.levels.full', { max: MERCHANT_LEVELS_MAX })}
        </p>
      )}
      {levels.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full" />
          ))}
        </div>
      )}
      {levels.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, levels.error)}
          action={
            <Button variant="outline" onClick={() => levels.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {levels.isSuccess && live.length === 0 && (
        <EmptyState
          icon={<MedalIcon />}
          title={t('merchants.levels.empty')}
          description={t('merchants.levels.emptyHint')}
        />
      )}
      {live.length > 0 && (
        <LevelTable
          levels={live}
          onEdit={(level) => setEditing(level)}
          onArchive={(level) => setArchiving(level)}
        />
      )}
      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{t('merchants.levels.archived')}</h2>
          <LevelTable levels={archived} />
        </section>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <LevelDialog
            key={editing === 'new' ? 'new' : editing.id}
            level={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={t('merchants.levels.archiveTitle', { name: archiving?.nameAr ?? '' })}
        body={t('merchants.levels.archiveBody')}
        action={t('merchants.levels.archive')}
        destructive
        pending={archive.isPending}
        onConfirm={async () => {
          if (archiving) await archive.mutateAsync(archiving.id);
        }}
      />
    </>
  );
}

function LevelTable({
  levels,
  onEdit,
  onArchive,
}: {
  levels: MerchantLevel[];
  onEdit?: (level: MerchantLevel) => void;
  onArchive?: (level: MerchantLevel) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('merchants.levels.columns.name')}</TableHead>
          <TableHead>{t('merchants.levels.columns.threshold')}</TableHead>
          <TableHead>{t('merchants.levels.columns.list')}</TableHead>
          <TableHead>{t('merchants.levels.columns.merchants')}</TableHead>
          <TableHead>{t('merchants.levels.columns.since')}</TableHead>
          {onEdit && (
            <TableHead>
              <span className="sr-only">{t('merchants.columns.actions')}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {levels.map((level) => (
          <TableRow key={level.id}>
            <TableCell className="font-medium">{level.nameAr}</TableCell>
            <TableCell className="tabular-nums">
              <bdi dir="ltr">{formatUsd(level.monthlyThresholdUsdUnits)}</bdi>
            </TableCell>
            <TableCell>
              <span className="flex flex-wrap items-center gap-2">
                {level.priceList.name}
                <Badge tone="neutral">
                  {t(`merchants.levels.kinds.${level.priceList.priceKind}`)}
                </Badge>
              </span>
            </TableCell>
            <TableCell className="tabular-nums">{level.merchantCount}</TableCell>
            <TableCell>{formatDate(level.archivedAt ?? level.createdAt)}</TableCell>
            {onEdit && onArchive && (
              <TableCell>
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => onEdit(level)}>
                    <PencilIcon />
                    {t('merchants.levels.edit')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onArchive(level)}>
                    <ArchiveIcon />
                    {t('merchants.levels.archive')}
                  </Button>
                </span>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type LevelField = 'nameAr' | 'monthlyThresholdUsdUnits' | 'priceListId';

/** LV1: name, whole-dollar monthly threshold and a wholesale or custom list. */
function LevelDialog({ level, onDone }: { level: MerchantLevel | null; onDone: () => void }) {
  const { t } = useTranslation();
  const create = useCreateMerchantLevel();
  const update = useUpdateMerchantLevel(level?.id ?? '');
  const lists = useQuery(priceListsQuery);
  const items = (lists.data ?? [])
    .filter(
      (list) =>
        list.archivedAt === null &&
        list.ready &&
        (list.kind === 'wholesale' || list.kind === 'custom'),
    )
    .map((list) => ({ value: list.id, label: list.name }));
  const [listId, setListId] = useState<string>(
    level?.priceList.id ?? ROOT_PRICE_LIST_IDS.wholesale,
  );
  const [invalid, setInvalid] = useState<Set<LevelField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const pending = create.isPending || update.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const parsed = merchantLevelInputSchema.safeParse({
      nameAr: String(form.get('nameAr') ?? ''),
      monthlyThresholdUsdUnits: parseUsd(String(form.get('threshold') ?? '')) ?? undefined,
      priceListId: listId,
    });
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => issue.path[0] as LevelField)));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      if (level) await update.mutateAsync(parsed.data);
      else await create.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>
          {level
            ? t('merchants.levels.editTitle', { name: level.nameAr })
            : t('merchants.levels.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('merchants.levels.dialogDescription')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('nameAr')}>
          <FieldLabel>{t('merchants.levels.fields.name')}</FieldLabel>
          <Input name="nameAr" maxLength={30} autoComplete="off" defaultValue={level?.nameAr} />
          <FieldError match={invalid.has('nameAr')}>
            {t('merchants.levels.validation.name')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('monthlyThresholdUsdUnits')}>
          <FieldLabel>{t('merchants.levels.fields.threshold')}</FieldLabel>
          <Input
            name="threshold"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={
              level ? formatAmountInput('USD', level.monthlyThresholdUsdUnits) : undefined
            }
          />
          <FieldDescription>{t('merchants.levels.hints.threshold')}</FieldDescription>
          <FieldError match={invalid.has('monthlyThresholdUsdUnits')}>
            {t('merchants.levels.validation.threshold')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('priceListId')}>
          <FieldLabel render={<span />}>{t('merchants.levels.fields.list')}</FieldLabel>
          <Picker
            label={t('merchants.levels.fields.list')}
            items={items}
            value={listId}
            onChange={setListId}
            read={lists}
          />
          <FieldDescription>{t('merchants.levels.hints.list')}</FieldDescription>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <InvalidAlert show={invalid.size > 0} />
          <Button type="submit" disabled={pending}>
            {level ? t('merchants.levels.save') : t('merchants.levels.add')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
