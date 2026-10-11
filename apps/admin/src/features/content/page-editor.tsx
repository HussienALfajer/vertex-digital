import { useQuery } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import {
  type ContentPage,
  PAGE_BODY_MAX,
  type PageDraft,
  parseRichText,
  savePageDraftSchema,
} from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@vertex-digital/ui';
import { ArrowRightIcon, EyeIcon, HistoryIcon, SaveIcon, SendIcon } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorCode, errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  pageQuery,
  pageVersionQuery,
  usePublishPage,
  useRestoreVersion,
  useSaveDraft,
} from './content.queries';
import {
  LinkWarnings,
  ProblemList,
  RichPreview,
  refusedFields,
  refusedProblems,
  StorePreview,
} from './content-parts';

/**
 * One page's editor (S14 PG3–PG6): the title and the limited-Markdown body with its problems by
 * line, the store-styled preview (side by side on desktop, a tab on phones), "حفظ المسودة" (also
 * Ctrl+S) over the revision last read, "نشر" of the saved revision, and the versions with a
 * read-only preview and "استعادة إلى المسودة". Leaving with unsaved changes asks first.
 */
export function PageEditor({ page }: { page: ContentPage }) {
  const { t } = useTranslation();
  const draft = useQuery(pageQuery(page));
  // The copy being edited starts from the first answer; later reads only feed the versions list.
  const [initial, setInitial] = useState<PageDraft | null>(null);
  useEffect(() => {
    if (draft.data && !initial) setInitial(draft.data);
  }, [draft.data, initial]);

  const back = (
    <Button variant="ghost" render={<Link to="/content/pages" />}>
      <ArrowRightIcon />
      {t('content.pages.back')}
    </Button>
  );
  if (draft.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        {back}
        <FormAlert>{errorMessage(t, draft.error)}</FormAlert>
        <Button variant="outline" onClick={() => draft.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!draft.data || !initial) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  return (
    <Editor
      // A reload after a refusal starts a fresh copy from the stored draft.
      key={`${initial.revision}:${initial.updatedAt}`}
      page={page}
      initial={initial}
      current={draft.data}
      back={back}
      onReload={async () => {
        const fresh = await draft.refetch();
        if (fresh.data) setInitial(fresh.data);
      }}
      onReplaced={setInitial}
    />
  );
}

type Saved = Pick<PageDraft, 'title' | 'body' | 'revision'>;

function Editor({
  page,
  initial,
  current,
  back,
  onReload,
  onReplaced,
}: {
  page: ContentPage;
  initial: PageDraft;
  /** The newest read of the draft: its versions and published state. */
  current: PageDraft;
  back: React.ReactNode;
  onReload: () => Promise<void>;
  /** A restore answered a new draft: the editor starts again from it. */
  onReplaced: (draft: PageDraft) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const save = useSaveDraft(page);
  const publish = usePublishPage(page);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [saved, setSaved] = useState<Saved>(initial);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const deferredBody = useDeferredValue(body);
  const deferredTitle = useDeferredValue(title);
  const problems = parseRichText(deferredBody).problems;
  const [serverProblems, setServerProblems] = useState<typeof problems>([]);
  const dirty = title !== saved.title || body !== saved.body;
  const published = current.latestVersion;

  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const refused = useCallback(
    (error: unknown) => {
      if (errorCode(error) === 'CONTENT_STALE') {
        setStale(true);
        return;
      }
      const lines = refusedProblems(error, 'body');
      setServerProblems(lines);
      if (refusedFields(error).has('title')) setTitleError(t('content.pages.errors.title'));
      if (lines.length === 0) setFailure(errorMessage(t, error));
    },
    [t],
  );

  const submit = useCallback(async () => {
    setFailure(null);
    setServerProblems([]);
    const parsed = savePageDraftSchema.safeParse({ title, body, revision: saved.revision });
    const titleIssue = parsed.error?.issues.some((issue) => issue.path[0] === 'title');
    setTitleError(titleIssue ? t('content.pages.errors.title') : null);
    if (!parsed.success || save.isPending) return;
    try {
      const result = await save.mutateAsync(parsed.data);
      setSaved({ title: result.title, body: result.body, revision: result.revision });
      toast.add({ title: t('content.pages.saved'), type: 'success' });
    } catch (error) {
      refused(error);
    }
  }, [title, body, saved.revision, save, refused, t]);

  // Ctrl+S (or ⌘S) saves the draft instead of the browser saving the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  const shownProblems = problems.length > 0 ? problems : serverProblems;
  const canPublish = !dirty && saved.body.trim() !== '' && problems.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={initial.title}
        description={
          published
            ? t('content.pages.published', {
                version: published.version,
                date: formatDate(published.publishedAt),
              })
            : t('content.pages.unpublished')
        }
        actions={
          <>
            {back}
            {dirty && <Badge tone="warning">{t('content.pages.unsaved')}</Badge>}
            <Button variant="outline" disabled={save.isPending} onClick={() => void submit()}>
              <SaveIcon />
              {t('content.pages.save')}
            </Button>
            <Button disabled={!canPublish} onClick={() => setPublishing(true)}>
              <SendIcon />
              {t('content.pages.publish')}
            </Button>
          </>
        }
      />
      {dirty && (
        <p className="-mt-3 text-sm text-muted-foreground">{t('content.pages.saveFirst')}</p>
      )}

      <Tabs
        value={view}
        onValueChange={(value) => setView(value as 'edit' | 'preview')}
        className="lg:hidden"
      >
        <TabsList>
          <TabsTrigger value="edit">{t('content.pages.editTab')}</TabsTrigger>
          <TabsTrigger value="preview">{t('content.pages.previewTab')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <form
          className={cn('flex flex-col gap-5', view === 'preview' && 'max-lg:hidden')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <Field invalid={!!titleError}>
            <FieldLabel htmlFor={titleId}>{t('content.pages.title')}</FieldLabel>
            <Input
              id={titleId}
              value={title}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
            <FieldError match={!!titleError}>{titleError}</FieldError>
          </Field>
          <Field invalid={shownProblems.length > 0}>
            <FieldLabel>{t('content.pages.body')}</FieldLabel>
            <Textarea
              value={body}
              rows={22}
              maxLength={PAGE_BODY_MAX}
              dir="rtl"
              // Each line takes the direction of its own first letter (an English line stays LTR).
              className="[unicode-bidi:plaintext]"
              onChange={(event) => setBody(event.target.value)}
            />
            <FieldDescription>{t('content.syntax')}</FieldDescription>
          </Field>
          <ProblemList problems={shownProblems} />
          <LinkWarnings source={deferredBody} />
          {failure && <FormAlert>{failure}</FormAlert>}
        </form>
        <StorePreview className={cn(view === 'edit' && 'max-lg:hidden')}>
          <PagePreview title={deferredTitle} body={deferredBody} />
        </StorePreview>
      </div>

      <Versions
        page={page}
        draft={current}
        revision={saved.revision}
        dirty={dirty}
        onRestored={(next) => {
          setSaved(next);
          onReplaced(next);
        }}
        onStale={() => setStale(true)}
      />

      <ConfirmDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        title={t('content.pages.publishTitle')}
        body={t('content.pages.publishBody')}
        action={t('content.pages.publish')}
        pending={publish.isPending}
        onConfirm={async () => {
          try {
            const version = await publish.mutateAsync(saved.revision);
            toast.add({
              title: t('content.pages.publishedToast', { version: version.version }),
              type: 'success',
            });
          } catch (error) {
            if (errorCode(error) === 'CONTENT_STALE') {
              setPublishing(false);
              setStale(true);
              return;
            }
            const lines = refusedProblems(error, 'body');
            if (lines.length > 0) {
              setPublishing(false);
              setServerProblems(lines);
              return;
            }
            throw error;
          }
        }}
      />
      <StaleDialog
        open={stale}
        onReload={async () => {
          setStale(false);
          await onReload();
        }}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title={t('content.pages.leave.title')}
        body={t('content.pages.leave.body')}
        action={t('content.pages.leave.leave')}
        destructive
        pending={false}
        onConfirm={async () => blocker.proceed?.()}
      />
    </div>
  );
}

/** The page as the store shows it (PG2): the title, the update line and the body in a column. */
function PagePreview({ title, body, date }: { title: string; body: string; date?: string }) {
  const { t } = useTranslation();
  return (
    <article className="flex flex-col gap-2 px-4 py-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">
        {t('content.pages.updated', { date: formatDate(date ?? new Date().toISOString()) })}
      </p>
      <div className="mt-4 max-w-[70ch]">
        <RichPreview source={body} />
      </div>
    </article>
  );
}

/** PG3: another tab saved or published first; the editor offers to reload the stored draft. */
function StaleDialog({ open, onReload }: { open: boolean; onReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('content.stale.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('content.stale.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await onReload();
              } finally {
                setPending(false);
              }
            }}
          >
            {t('content.stale.reload')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The versions, newest first (PG5): "عرض" read-only, "استعادة إلى المسودة" (PG6). */
function Versions({
  page,
  draft,
  revision,
  dirty,
  onRestored,
  onStale,
}: {
  page: ContentPage;
  draft: PageDraft;
  revision: number;
  dirty: boolean;
  onRestored: (draft: PageDraft) => void;
  onStale: () => void;
}) {
  const { t } = useTranslation();
  const restore = useRestoreVersion(page);
  const [viewing, setViewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <HistoryIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        {t('content.versions.title')}
      </h2>
      {draft.versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('content.versions.none')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('content.versions.number')}</TableHead>
              <TableHead>{t('content.pages.title')}</TableHead>
              <TableHead>{t('content.versions.date')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('content.versions.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.versions.map((version) => (
              <TableRow key={version.version}>
                <TableCell className="tabular-nums">{version.version}</TableCell>
                <TableCell>{version.title}</TableCell>
                <TableCell>{formatDate(version.publishedAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setViewing(version.version)}>
                      <EyeIcon />
                      {t('content.versions.view')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRestoring(version.version)}
                    >
                      {t('content.versions.restore')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        {viewing !== null && <VersionDialog page={page} version={viewing} />}
      </Dialog>
      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title={t('content.versions.restoreTitle', { version: restoring ?? 0 })}
        body={dirty ? t('content.versions.restoreUnsaved') : t('content.versions.restoreBody')}
        action={t('content.versions.restore')}
        destructive={dirty}
        pending={restore.isPending}
        onConfirm={async () => {
          if (restoring === null) return;
          try {
            onRestored(await restore.mutateAsync({ version: restoring, revision }));
            toast.add({ title: t('content.versions.restored'), type: 'success' });
          } catch (error) {
            if (errorCode(error) === 'CONTENT_STALE') {
              setRestoring(null);
              onStale();
              return;
            }
            throw error;
          }
        }}
      />
    </section>
  );
}

function VersionDialog({ page, version }: { page: ContentPage; version: number }) {
  const { t } = useTranslation();
  const read = useQuery(pageVersionQuery(page, version));
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('content.versions.viewTitle', { version })}</DialogTitle>
      </DialogHeader>
      {read.isPending && <Skeleton className="h-64 w-full" aria-hidden="true" />}
      {read.isError && <FormAlert>{errorMessage(t, read.error)}</FormAlert>}
      {read.data && (
        <StorePreview>
          <PagePreview title={read.data.title} body={read.data.body} date={read.data.publishedAt} />
        </StorePreview>
      )}
    </DialogContent>
  );
}
