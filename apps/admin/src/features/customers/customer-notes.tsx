import { useInfiniteQuery } from '@tanstack/react-query';
import { type CustomerNote, createCustomerNoteSchema } from '@vertex-digital/contracts';
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
 * never reach the customer, Telegram or email; their text never changes.
 */
export function NotesSection({ customerId }: { customerId: string }) {
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
        <Button variant="ghost" size="sm" onClick={() => setArchived(!archived)}>
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
            <NoteItem key={note.id} customerId={customerId} note={note} />
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

function NoteItem({ customerId, note }: { customerId: string; note: CustomerNote }) {
  const { t } = useTranslation();
  const action = useNoteAction(customerId);
  const [failure, setFailure] = useState<string | null>(null);

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
              disabled={action.isPending}
              onClick={() => run('pin')}
            >
              <PinIcon />
              {t('customers.notes.pin')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => run('archive')}
          >
            <ArchiveIcon />
            {t('customers.notes.archive')}
          </Button>
        </div>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
    </li>
  );
}
