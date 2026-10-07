import { useInfiniteQuery } from '@tanstack/react-query';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_ENTITY_TYPES,
  type AuditEntry,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { SearchXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { auditListQuery } from './audit.queries';
import { AuditDetailSheet } from './audit-detail-sheet';
import { actorLabel, shortId } from './audit-labels';
import { type AuditSearch, isUuid } from './audit-search';

const ALL = 'all';

/**
 * The audit log (rule A4): newest first with "load more", filtered by actor, action, entity and
 * dates; a row opens the entry in full. Filters live in the URL.
 */
export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (search: AuditSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(auditListQuery(search));
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Object.keys(search).length > 0;

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />
      {/* A new key resets the form's fields when the URL changes (clear, back). */}
      <AuditFilters key={JSON.stringify(search)} search={search} onSearch={onSearch} />
      {list.isPending && <TableSkeleton />}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && entries.length === 0 && (
        <EmptyState
          icon={<SearchXIcon />}
          title={t('audit.emptyTitle')}
          description={filtered ? t('audit.emptyBody') : undefined}
          action={
            filtered && (
              <Button variant="outline" onClick={() => onSearch({})}>
                {t('audit.filters.clear')}
              </Button>
            )
          }
        />
      )}
      {entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('audit.columns.time')}</TableHead>
              <TableHead>{t('audit.columns.actor')}</TableHead>
              <TableHead>{t('audit.columns.action')}</TableHead>
              <TableHead>{t('audit.columns.entity')}</TableHead>
              <TableHead>{t('audit.columns.channel')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id} className="cursor-pointer" onClick={() => setOpen(entry)}>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(entry.occurredAt)}
                </TableCell>
                <TableCell>{actorLabel(t, entry)}</TableCell>
                <TableCell>
                  {/* The keyboard way into the detail; the whole row also opens it. */}
                  <button
                    type="button"
                    className="rounded-sm text-start font-medium text-foreground hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpen(entry);
                    }}
                  >
                    {t(`audit.actions.${entry.action}`)}
                  </button>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    {t(`audit.entityTypes.${entry.entityType}`)}
                    <code dir="ltr" className="text-muted-foreground">
                      {shortId(entry.entityId)}
                    </code>
                    <CopyButton
                      value={entry.entityId}
                      label={t('audit.copyId', { id: entry.entityId })}
                    />
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {t(`audit.channels.${entry.channel}`)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
      <AuditDetailSheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}

function AuditFilters({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (search: AuditSearch) => void;
}) {
  const { t } = useTranslation();
  const [actorKind, setActorKind] = useState<string>(search.actorKind ?? ALL);
  const [action, setAction] = useState<string>(search.action ?? ALL);
  const [entityType, setEntityType] = useState<string>(search.entityType ?? ALL);
  const [invalid, setInvalid] = useState<{ actorId?: boolean; entityId?: boolean }>({});
  const withActorId = actorKind === 'customer' || actorKind === 'admin';

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const actorId = withActorId ? value('actorId') : '';
    const entityId = value('entityId');
    const found = {
      actorId: !!actorId && !isUuid(actorId),
      entityId: !!entityId && !isUuid(entityId),
    };
    setInvalid(found);
    if (found.actorId || found.entityId) return;
    const next: Record<string, string> = {
      actorKind,
      actorId,
      action,
      entityType,
      entityId,
      from: value('from'),
      to: value('to'),
    };
    onSearch(
      Object.fromEntries(
        Object.entries(next).filter(([, item]) => item && item !== ALL),
      ) as AuditSearch,
    );
  }

  return (
    <Card>
      <form
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={apply}
        noValidate
        aria-label={t('audit.title')}
      >
        <FilterSelect
          label={t('audit.filters.actorKind')}
          value={actorKind}
          onChange={setActorKind}
          options={AUDIT_ACTOR_KINDS.map((kind) => ({
            value: kind,
            label: t(`audit.actorKinds.${kind}`),
          }))}
        />
        {withActorId && (
          <Field invalid={invalid.actorId}>
            <FieldLabel>{t('audit.filters.actorId')}</FieldLabel>
            <Input name="actorId" dir="ltr" defaultValue={search.actorId} spellCheck={false} />
            <FieldError match={!!invalid.actorId}>{t('audit.filters.invalidId')}</FieldError>
          </Field>
        )}
        <FilterSelect
          label={t('audit.filters.action')}
          value={action}
          onChange={setAction}
          options={AUDIT_ACTIONS.map((item) => ({
            value: item,
            label: t(`audit.actions.${item}`),
          }))}
        />
        <FilterSelect
          label={t('audit.filters.entityType')}
          value={entityType}
          onChange={setEntityType}
          options={AUDIT_ENTITY_TYPES.map((type) => ({
            value: type,
            label: t(`audit.entityTypes.${type}`),
          }))}
        />
        <Field invalid={invalid.entityId}>
          <FieldLabel>{t('audit.filters.entityId')}</FieldLabel>
          <Input name="entityId" dir="ltr" defaultValue={search.entityId} spellCheck={false} />
          <FieldError match={!!invalid.entityId}>{t('audit.filters.invalidId')}</FieldError>
        </Field>
        <Field>
          <FieldLabel>{t('audit.filters.from')}</FieldLabel>
          <Input name="from" type="date" dir="ltr" defaultValue={search.from} />
        </Field>
        <Field>
          <FieldLabel>{t('audit.filters.to')}</FieldLabel>
          <Input name="to" type="date" dir="ltr" defaultValue={search.to} />
        </Field>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit">{t('audit.filters.apply')}</Button>
          <Button variant="ghost" onClick={() => onSearch({})}>
            {t('audit.filters.clear')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const items = [{ value: ALL, label: t('audit.filters.all') }, ...options];
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => onChange(next ?? ALL)}>
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
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity.
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}
