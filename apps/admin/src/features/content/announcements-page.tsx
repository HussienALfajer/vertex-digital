import { useQuery } from '@tanstack/react-query';
import {
  ANNOUNCEMENT_TONES,
  ANNOUNCEMENTS_MAX,
  type Announcement,
  type AnnouncementTone,
  announcementInputSchema,
} from '@vertex-digital/contracts';
import {
  AnnouncementBar,
  Badge,
  Button,
  Checkbox,
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
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArchiveIcon, ArchiveRestoreIcon, MegaphoneIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ReadFailure } from '../../components/read-failure';
import { useVisibleAgain } from '../../lib/admin-stream';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { ScheduleFields } from './banner-dialog';
import {
  announcementsQuery,
  type RowAction,
  useAnnouncementAction,
  useSaveAnnouncement,
} from './content.queries';
import {
  LinkWarnings,
  linkMarkdown,
  refusedFields,
  ScheduleText,
  StaleRead,
  StateBadge,
  StorePreview,
} from './content-parts';
import { fromDamascusInput } from './damascus-time';

/**
 * "الإعلان" (S14 AN1–AN4): the announcements with their text, tone, link, schedule and state, the
 * enable switch (a confirm naming the one it replaces, AN2), edit, archive and restore.
 */
export function AnnouncementsPage({
  archived,
  onArchived,
}: {
  archived: boolean;
  onArchived: (archived: boolean) => void;
}) {
  const { t } = useTranslation();
  const archivedId = useId();
  const announcements = useQuery(announcementsQuery(archived));
  // States follow the clock, and AN2's confirmation names the enabled one: read again (A08-23).
  useVisibleAgain(() => void announcements.refetch());
  const action = useAnnouncementAction();
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [replacing, setReplacing] = useState<{ next: Announcement; current: Announcement } | null>(
    null,
  );
  const [archiving, setArchiving] = useState<Announcement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(id: string, verb: RowAction) {
    setFailure(null);
    try {
      await action.mutateAsync({ id, action: verb });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  if (announcements.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (!announcements.data) {
    return <ReadFailure error={announcements.error} onRetry={() => announcements.refetch()} />;
  }
  const list = announcements.data;
  const live = list.filter((row) => !row.archivedAt);
  const enabled = live.find((row) => row.enabled) ?? null;

  function toggle(row: Announcement, on: boolean) {
    if (on && enabled && enabled.id !== row.id) setReplacing({ next: row, current: enabled });
    else void act(row.id, on ? 'enable' : 'disable');
  }

  return (
    <div className="flex flex-col gap-6">
      {announcements.isError && <StaleRead onRetry={() => announcements.refetch()} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor={archivedId} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id={archivedId}
            checked={archived}
            onCheckedChange={(value) => onArchived(value)}
          />
          {t('content.archivedToggle')}
        </label>
        <Button disabled={live.length >= ANNOUNCEMENTS_MAX} onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('content.announcements.add')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('content.announcements.oneAtATime')}</p>
      {failure && <FormAlert>{failure}</FormAlert>}
      {list.length === 0 ? (
        <EmptyState
          icon={<MegaphoneIcon />}
          title={t('content.announcements.empty')}
          action={
            <Button onClick={() => setEditing('new')}>{t('content.announcements.add')}</Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('content.announcements.text')}</TableHead>
              <TableHead>{t('content.announcements.tone')}</TableHead>
              <TableHead>{t('content.banners.schedule')}</TableHead>
              <TableHead>{t('content.banners.state')}</TableHead>
              <TableHead>{t('content.banners.enabled')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('content.banners.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((row) => {
              const archivedRow = !!row.archivedAt;
              const name = { name: row.text };
              return (
                <TableRow key={row.id} data-testid="announcement-row">
                  <TableCell className="max-w-md">
                    <span className="block">{row.text}</span>
                    {row.linkPath && (
                      <span className="block text-sm text-muted-foreground">
                        {ltr(row.linkPath)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={row.tone === 'warning' ? 'warning' : 'info'}>
                      {t(`content.announcements.tones.${row.tone}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    <ScheduleText startsAt={row.startsAt} endsAt={row.endsAt} />
                  </TableCell>
                  <TableCell>
                    <StateBadge state={row.state} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={t('content.announcements.enableLabel', name)}
                      checked={row.enabled}
                      disabled={archivedRow || action.isPending}
                      onCheckedChange={(value) => toggle(row, value)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {!archivedRow && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-11"
                          aria-label={t('content.actions.editNamed', name)}
                          onClick={() => setEditing(row)}
                        >
                          <PencilIcon />
                          {t('content.actions.edit')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11"
                        aria-label={t(
                          archivedRow
                            ? 'content.actions.restoreNamed'
                            : 'content.actions.archiveNamed',
                          name,
                        )}
                        disabled={action.isPending}
                        onClick={() =>
                          archivedRow ? void act(row.id, 'restore') : setArchiving(row)
                        }
                      >
                        {archivedRow ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                        {archivedRow ? t('content.actions.restore') : t('content.actions.archive')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <AnnouncementDialog
            announcement={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={t('content.announcements.archiveTitle')}
        body={
          archiving?.state === 'live'
            ? t('content.announcements.archiveLiveBody', { text: archiving.text })
            : t('content.announcements.archiveBody', { text: archiving?.text ?? '' })
        }
        action={t('content.actions.archive')}
        destructive
        pending={action.isPending}
        onConfirm={async () => {
          if (archiving) await action.mutateAsync({ id: archiving.id, action: 'archive' });
        }}
      />
      <ConfirmDialog
        open={replacing !== null}
        onClose={() => setReplacing(null)}
        title={t('content.announcements.replaceTitle')}
        body={t('content.announcements.replaceBody', { text: replacing?.current.text ?? '' })}
        action={t('content.announcements.replace')}
        pending={action.isPending}
        onConfirm={async () => {
          if (replacing) await action.mutateAsync({ id: replacing.next.id, action: 'enable' });
        }}
      />
    </div>
  );
}

type AnnouncementField = 'text' | 'linkPath' | 'startsAt' | 'endsAt';

/** Add or edit an announcement (AN1): plain text, a link, a tone, a schedule; the bar previewed. */
function AnnouncementDialog({
  announcement,
  onDone,
}: {
  announcement: Announcement | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveAnnouncement();
  const [text, setText] = useState(announcement?.text ?? '');
  const [linkPath, setLinkPath] = useState(announcement?.linkPath ?? '');
  const [tone, setTone] = useState<AnnouncementTone>(announcement?.tone ?? 'info');
  const [errors, setErrors] = useState<Partial<Record<AnnouncementField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const clipped = usePhoneClip(text, linkPath.trim() !== '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const time = (name: string) => {
      const value = String(data.get(name) ?? '').trim();
      return value ? (fromDamascusInput(value) ?? 'invalid') : null;
    };
    const parsed = announcementInputSchema.safeParse({
      text,
      linkPath: linkPath.trim() || null,
      tone,
      startsAt: time('startsAt'),
      endsAt: time('endsAt'),
    });
    const found: typeof errors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = String(issue.path[0]) as AnnouncementField;
      found[field] = t(`content.announcements.errors.${field}`);
    }
    setErrors(found);
    if (!parsed.success) return focusInvalid();
    try {
      await save.mutateAsync({ id: announcement?.id, body: parsed.data });
      onDone();
    } catch (error) {
      const fields = refusedFields(error);
      if (fields.size === 0) {
        setFailure(errorMessage(t, error));
        return;
      }
      setErrors(
        Object.fromEntries(
          [...fields].map((field) => [
            field,
            field === 'startsAt' || field === 'endsAt'
              ? t('content.schedule.past')
              : t(`content.announcements.errors.${field as AnnouncementField}`),
          ]),
        ),
      );
      focusInvalid();
    }
  }

  const details = (
    <span className="font-medium underline underline-offset-4">
      {t('content.announcements.details')}
    </span>
  );
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>
          {announcement ? t('content.announcements.editTitle') : t('content.announcements.add')}
        </DialogTitle>
        <DialogDescription>{t('content.announcements.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.text}>
          <FieldLabel>{t('content.announcements.text')}</FieldLabel>
          <Input
            value={text}
            maxLength={140}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>
            {t('content.announcements.textHint', { count: text.trim().length })}
          </FieldDescription>
          {clipped.cut && (
            <p className="text-sm text-status-warning-foreground" data-testid="phone-clip">
              {t('content.announcements.phoneClip')}
            </p>
          )}
          <FieldError match={!!errors.text}>{errors.text}</FieldError>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={!!errors.linkPath}>
            <FieldLabel>{t('content.link')}</FieldLabel>
            <Input
              dir="ltr"
              value={linkPath}
              placeholder="/faq"
              maxLength={200}
              autoComplete="off"
              onChange={(event) => setLinkPath(event.target.value)}
            />
            <FieldDescription>{t('content.linkHint')}</FieldDescription>
            <LinkWarnings source={linkMarkdown(linkPath)} />
            <FieldError match={!!errors.linkPath}>{errors.linkPath}</FieldError>
          </Field>
          <Field>
            <FieldLabel render={<span />}>{t('content.announcements.tone')}</FieldLabel>
            <ToggleGroup<AnnouncementTone>
              aria-label={t('content.announcements.tone')}
              value={[tone]}
              onValueChange={(value) => value[0] && setTone(value[0])}
            >
              {ANNOUNCEMENT_TONES.map((item) => (
                <ToggleGroupItem key={item} value={item}>
                  {t(`content.announcements.tones.${item}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </div>
        <ScheduleFields
          startsAt={announcement?.startsAt ?? null}
          endsAt={announcement?.endsAt ?? null}
          errors={errors}
        />
        <StorePreview>
          <div className="flex flex-col gap-2 py-3" data-testid="announcement-preview">
            {(tone === 'info' ? ANNOUNCEMENT_TONES : [...ANNOUNCEMENT_TONES].reverse()).map(
              (item) => (
                <AnnouncementBar
                  key={item}
                  tone={item}
                  text={text.trim() || t('content.announcements.text')}
                  action={linkPath.trim() ? details : undefined}
                />
              ),
            )}
          </div>
        </StorePreview>
        {clipped.probe}
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" disabled={save.isPending}>
            {t('content.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Whether the bar cuts the text at the store's phone width (AN1 allows 140 characters; two lines hold about
 * 75 there): an unseen bar at 375 px is measured as the text changes (audit A08-32).
 */
function usePhoneClip(text: string, linked: boolean) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the bar is measured again whenever its text or link changes
  useLayoutEffect(() => {
    const shown = box.current?.querySelector('[data-slot="announcement-text"]');
    setCut(!!shown && shown.scrollHeight > shown.clientHeight + 1);
  }, [text, linked]);
  const probe = (
    <div
      ref={box}
      aria-hidden="true"
      className="pointer-events-none invisible absolute -z-10 h-0 overflow-hidden"
    >
      <div className="w-[375px]">
        <AnnouncementBar
          tone="info"
          text={text.trim()}
          action={linked ? <span>{t('content.announcements.details')}</span> : undefined}
          close={<span className="size-11 shrink-0" />}
        />
      </div>
    </div>
  );
  return { cut, probe };
}
