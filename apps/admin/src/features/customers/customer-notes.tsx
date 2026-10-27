import { useInfiniteQuery } from '@tanstack/react-query';
import {
  type AdminCustomer,
  type CustomerNote,
  createCustomerNoteSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArchiveIcon, NotebookPenIcon, PinIcon, PinOffIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { SectionError, SectionSkeleton } from './customer-sections';
import {
  customerNotesQuery,
  type NoteAction,
  useAddCustomerNote,
  useNoteAction,
} from './customers.queries';

/**
 * "الملاحظات" (rule SN2): add a note (optionally pinned, which replaces the pinned one), the
 * notes newest first with pin, unpin and archive, the archived ones behind "عرض المؤرشفة". Notes
 * never reach the customer, Telegram or email; their text never changes. Archiving asks first,
 * quoting the note, and so does pinning over the pinned note (audit A07-13).
 */
export function NotesSection({
  customerId,
  pinnedNote,
}: {
  customerId: string;
  /** The profile's pinned note, the one a pin replaces. */
  pinnedNote: AdminCustomer['pinnedNote'];
}) {
  const { t } = useTranslation();
  const [archived, setArchived] = useState(false);
  const list = useInfiniteQuery(customerNotesQuery(customerId, archived));
  const notes = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6">
      {!archived && <AddNote customerId={customerId} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          {archived ? t('customers.notes.showArchived') : t('customers.sections.notes')}
        </h2>
        <Button variant="ghost" size="sm" className="h-11" onClick={() => setArchived(!archived)}>
          {archived ? t('customers.notes.hideArchived') : t('customers.notes.showArchived')}
        </Button>
      </div>
      {list.isPending && <SectionSkeleton />}
      {list.isError && <SectionError error={list.error} onRetry={() => list.refetch()} />}
      {list.isSuccess && notes.length === 0 && (
        <EmptyState
          icon={<NotebookPenIcon />}
          title={archived ? t('customers.notes.emptyArchived') : t('customers.notes.empty')}
        />
      )}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-3">
          {notes.map((note) => (
            <NoteItem key={note.id} customerId={customerId} note={note} pinnedNote={pinnedNote} />
          ))}
        </ul>
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
    </div>
  );
}

function AddNote({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const add = useAddCustomerNote(customerId);
  const pinId = useId();
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = createCustomerNoteSchema.safeParse({ body, pinned });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    try {
      await add.mutateAsync(parsed.data);
      setBody('');
      setPinned(false);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('customers.notes.add')}</CardTitle>
        <CardDescription>{t('customers.notes.bodyHint')}</CardDescription>
      </CardHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('customers.notes.body')}</FieldLabel>
          <Textarea
            name="body"
            rows={3}
            maxLength={2000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <FieldError match={invalid}>{t('customers.notes.bodyError')}</FieldError>
        </Field>
        <div className="flex flex-col gap-1">
          <label htmlFor={pinId} className="flex items-center gap-2 text-base">
            <Checkbox
              id={pinId}
              checked={pinned}
              onCheckedChange={(checked) => setPinned(checked === true)}
            />
            {t('customers.notes.pinNew')}
          </label>
          <p className="ps-7 text-sm text-muted-foreground">{t('customers.notes.pinHint')}</p>
        </div>
        {failure && <FormAlert>{failure}</FormAlert>}
        <Button type="submit" className="self-start" disabled={add.isPending}>
          {add.isPending ? t('customers.notes.submitting') : t('customers.notes.submit')}
        </Button>
      </form>
    </Card>
  );
}

/** The start of a note, to name it in a confirmation. */
const EXCERPT_LENGTH = 80;

function useExcerpt() {
  const { t } = useTranslation();
  return (body: string) =>
    body.length > EXCERPT_LENGTH
      ? t('customers.notes.excerpt', { text: body.slice(0, EXCERPT_LENGTH).trimEnd() })
      : body;
}

function NoteItem({
  customerId,
  note,
  pinnedNote,
}: {
  customerId: string;
  note: CustomerNote;
  pinnedNote: AdminCustomer['pinnedNote'];
}) {
  const { t } = useTranslation();
  const excerpt = useExcerpt();
  const action = useNoteAction(customerId);
  const [failure, setFailure] = useState<string | null>(null);
  // The kind outlives the dialog, so its text does not change while it fades out.
  const [confirm, setConfirm] = useState<{ open: boolean; kind: 'pin' | 'archive' }>({
    open: false,
    kind: 'archive',
  });
  const replaces = pinnedNote && pinnedNote.id !== note.id ? pinnedNote : null;

  async function run(next: NoteAction) {
    setFailure(null);
    try {
      await action.mutateAsync({ noteId: note.id, action: next });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {note.pinned && !note.archivedAt && (
          <Badge tone="gold">
            <PinIcon aria-hidden="true" />
            {t('customers.notes.pinned')}
          </Badge>
        )}
        <span>{formatDateTime(note.createdAt)}</span>
        {note.archivedAt && (
          <span>{t('customers.notes.archivedAt', { date: formatDateTime(note.archivedAt) })}</span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
      {!note.archivedAt && (
        <div className="flex flex-wrap gap-2">
          {note.pinned ? (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              disabled={action.isPending}
              onClick={() => run('unpin')}
            >
              <PinOffIcon />
              {t('customers.notes.unpin')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              disabled={action.isPending}
              onClick={() => (replaces ? setConfirm({ open: true, kind: 'pin' }) : run('pin'))}
            >
              <PinIcon />
              {t('customers.notes.pin')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-11"
            disabled={action.isPending}
            onClick={() => setConfirm({ open: true, kind: 'archive' })}
          >
            <ArchiveIcon />
            {t('customers.notes.archive')}
          </Button>
        </div>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm((current) => ({ ...current, open: false }))}
        title={
          confirm.kind === 'pin' ? t('customers.notes.pinTitle') : t('customers.notes.archiveTitle')
        }
        body={
          confirm.kind === 'pin'
            ? t('customers.notes.pinBody', { excerpt: excerpt(replaces?.body ?? '') })
            : note.pinned
              ? t('customers.notes.archiveBodyPinned', { excerpt: excerpt(note.body) })
              : t('customers.notes.archiveBody', { excerpt: excerpt(note.body) })
        }
        action={
          confirm.kind === 'pin'
            ? t('customers.notes.pinConfirm')
            : t('customers.notes.archiveConfirm')
        }
        destructive={confirm.kind === 'archive'}
        pending={action.isPending}
        onConfirm={async () => {
          await action.mutateAsync({ noteId: note.id, action: confirm.kind });
        }}
      />
    </li>
  );
}
