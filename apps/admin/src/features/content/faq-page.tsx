import { useQuery } from '@tanstack/react-query';
import {
  FAQ_ITEMS_PER_SECTION_MAX,
  FAQ_SECTIONS_MAX,
  type FaqItem,
  type FaqOrder,
  type FaqSection,
  type FaqWorkingCopy,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  toast,
} from '@vertex-digital/ui';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  GripVerticalIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
} from 'lucide-react';
import { type DragEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorCode, errorMessage } from '../../lib/errors';
import { formatDate, formatSince } from '../../lib/format';
import { MoveButton } from '../catalog/catalog-parts';
import {
  faqQuery,
  useArchiveItem,
  useArchiveSection,
  usePublishFaq,
  useReorderFaq,
} from './content.queries';
import { RichPreview, StorePreview } from './content-parts';
import { FaqItemDialog, FaqSectionDialog } from './faq-dialogs';
import { faqOrder, withItemMoved, withSectionMoved } from './faq-order';

type Editing =
  | { kind: 'section'; section: FaqSection | null }
  | { kind: 'item'; item: FaqItem | null; sectionId: string };

/** What is being dragged (FQ4): a section, or a question inside its section. */
type Dragging = { sectionId: string | null; index: number };

/**
 * "الأسئلة الشائعة" (S14 FQ1–FQ6): the working copy as section cards with their questions, add,
 * edit, archive and restore, move up and down or drag to reorder, and the publish bar.
 */
export function FaqPage({
  archived,
  onArchived,
}: {
  archived: boolean;
  onArchived: (archived: boolean) => void;
}) {
  const { t } = useTranslation();
  const archivedId = useId();
  const faq = useQuery(faqQuery(archived));
  const reorder = useReorderFaq();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function sendOrder(order: FaqOrder) {
    setFailure(null);
    try {
      await reorder.mutateAsync(order);
    } catch (error) {
      // Edge case 7: a stale list is refused; the working copy is read again on settle.
      setFailure(errorMessage(t, error));
    }
  }

  if (faq.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (faq.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, faq.error)}</FormAlert>
        <Button variant="outline" onClick={() => faq.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const copy = faq.data;
  const live = copy.sections.filter((section) => !section.archivedAt);
  const order = faqOrder(copy);

  return (
    <div className="flex flex-col gap-6">
      <PublishBar copy={copy} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor={archivedId} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id={archivedId}
            checked={archived}
            onCheckedChange={(value) => onArchived(value)}
          />
          {t('content.archivedToggle')}
        </label>
        <Button
          disabled={live.length >= FAQ_SECTIONS_MAX}
          onClick={() => setEditing({ kind: 'section', section: null })}
        >
          <PlusIcon />
          {t('content.faq.addSection')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {copy.sections.length === 0 ? (
        <EmptyState
          icon={<MessageCircleQuestionIcon />}
          title={t('content.faq.empty')}
          action={
            <Button onClick={() => setEditing({ kind: 'section', section: null })}>
              {t('content.faq.addSection')}
            </Button>
          }
        />
      ) : (
        <SectionList
          copy={copy}
          order={order}
          pending={reorder.isPending}
          onOrder={(next) => void sendOrder(next)}
          onEdit={setEditing}
        />
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing?.kind === 'section' && (
          <FaqSectionDialog section={editing.section} onDone={() => setEditing(null)} />
        )}
        {editing?.kind === 'item' && (
          <FaqItemDialog
            item={editing.item}
            sectionId={editing.sectionId}
            sections={live}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

function SectionList({
  copy,
  order,
  pending,
  onOrder,
  onEdit,
}: {
  copy: FaqWorkingCopy;
  order: FaqOrder;
  pending: boolean;
  onOrder: (order: FaqOrder) => void;
  onEdit: (editing: Editing) => void;
}) {
  const [dragging, setDragging] = useState<Dragging | null>(null);

  /** Native drag and drop (FQ4); the move buttons do the same from the keyboard. */
  const drag = (sectionId: string | null, index: number) => ({
    draggable: !pending,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      setDragging({ sectionId, index });
    },
    onDragOver: (event: DragEvent) => {
      if (dragging?.sectionId === sectionId) event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (dragging?.sectionId === sectionId && dragging.index !== index) {
        onOrder(
          sectionId
            ? withItemMoved(order, sectionId, dragging.index, index)
            : withSectionMoved(order, dragging.index, index),
        );
      }
      setDragging(null);
    },
    onDragEnd: () => setDragging(null),
  });

  return (
    <div className="flex flex-col gap-4">
      {copy.sections.map((section) => {
        const position = order.sections.findIndex((entry) => entry.id === section.id);
        return (
          <SectionCard
            key={section.id}
            section={section}
            position={position}
            count={order.sections.length}
            order={order}
            pending={pending}
            drag={position >= 0 ? drag(null, position) : undefined}
            itemDrag={(index) => drag(section.id, index)}
            onOrder={onOrder}
            onEdit={onEdit}
          />
        );
      })}
    </div>
  );
}

function SectionCard({
  section,
  position,
  count,
  order,
  pending,
  drag,
  itemDrag,
  onOrder,
  onEdit,
}: {
  section: FaqWorkingCopy['sections'][number];
  /** In the unarchived order; -1 when archived. */
  position: number;
  count: number;
  order: FaqOrder;
  pending: boolean;
  drag?: object;
  itemDrag: (index: number) => object;
  onOrder: (order: FaqOrder) => void;
  onEdit: (editing: Editing) => void;
}) {
  const { t } = useTranslation();
  const archive = useArchiveSection();
  const [failure, setFailure] = useState<string | null>(null);
  const archived = !!section.archivedAt;
  const itemIds = order.sections[position]?.itemIds ?? [];
  const liveItems = section.items.filter((item) => !item.archivedAt).length;

  async function toggleArchive() {
    setFailure(null);
    try {
      await archive.mutateAsync({ id: section.id, archive: !archived });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-3 p-4" data-testid="faq-section" {...drag}>
      <div className="flex flex-wrap items-center gap-2">
        {!archived && (
          <GripVerticalIcon
            className="size-4 cursor-grab text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <h2 className="min-w-0 flex-1 text-lg font-semibold">{section.title}</h2>
        {archived && <Badge tone="neutral">{t('content.states.archived')}</Badge>}
        {!archived && (
          <>
            <MoveButton
              label={t('content.actions.moveUp')}
              disabled={pending}
              onClick={
                position > 0
                  ? () => onOrder(withSectionMoved(order, position, position - 1))
                  : undefined
              }
            >
              <ArrowUpIcon />
            </MoveButton>
            <MoveButton
              label={t('content.actions.moveDown')}
              disabled={pending}
              onClick={
                position < count - 1
                  ? () => onOrder(withSectionMoved(order, position, position + 1))
                  : undefined
              }
            >
              <ArrowDownIcon />
            </MoveButton>
            <Button variant="ghost" size="sm" onClick={() => onEdit({ kind: 'section', section })}>
              <PencilIcon />
              {t('content.actions.edit')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={archive.isPending}
          onClick={() => void toggleArchive()}
        >
          {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {archived ? t('content.actions.restore') : t('content.actions.archive')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {section.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('content.faq.noQuestions')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {section.items.map((item) => {
            const index = itemIds.indexOf(item.id);
            return (
              <ItemRow
                key={item.id}
                item={item}
                sectionArchived={archived}
                index={index}
                count={itemIds.length}
                pending={pending}
                drag={index >= 0 && !archived ? itemDrag(index) : undefined}
                onMove={(to) => onOrder(withItemMoved(order, section.id, index, to))}
                onEdit={() => onEdit({ kind: 'item', item, sectionId: section.id })}
              />
            );
          })}
        </ul>
      )}
      {!archived && (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={liveItems >= FAQ_ITEMS_PER_SECTION_MAX}
            onClick={() => onEdit({ kind: 'item', item: null, sectionId: section.id })}
          >
            <PlusIcon />
            {t('content.faq.addQuestion')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ItemRow({
  item,
  sectionArchived,
  index,
  count,
  pending,
  drag,
  onMove,
  onEdit,
}: {
  item: FaqItem;
  sectionArchived: boolean;
  /** In the section's unarchived order; -1 when archived. */
  index: number;
  count: number;
  pending: boolean;
  drag?: object;
  onMove: (to: number) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const archive = useArchiveItem();
  const [failure, setFailure] = useState<string | null>(null);
  const archived = !!item.archivedAt;
  const movable = !archived && !sectionArchived;

  async function toggleArchive() {
    setFailure(null);
    try {
      await archive.mutateAsync({ id: item.id, archive: !archived });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-testid="faq-item" {...drag}>
      <div className="flex flex-wrap items-center gap-2">
        {movable && (
          <GripVerticalIcon
            className="size-4 cursor-grab text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1">{item.question}</span>
        {archived && <Badge tone="neutral">{t('content.states.archived')}</Badge>}
        {movable && (
          <>
            <MoveButton
              label={t('content.actions.moveUp')}
              disabled={pending}
              onClick={index > 0 ? () => onMove(index - 1) : undefined}
            >
              <ArrowUpIcon />
            </MoveButton>
            <MoveButton
              label={t('content.actions.moveDown')}
              disabled={pending}
              onClick={index < count - 1 ? () => onMove(index + 1) : undefined}
            >
              <ArrowDownIcon />
            </MoveButton>
          </>
        )}
        {!archived && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <PencilIcon />
            {t('content.actions.edit')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={archive.isPending}
          onClick={() => void toggleArchive()}
        >
          {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {archived ? t('content.actions.restore') : t('content.actions.archive')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
    </li>
  );
}

/**
 * FQ6: "تعديلات غير منشورة منذ …" with the preview and "نشر الأسئلة" while the working copy is
 * ahead of the newest publication; else "منشورة، <date>".
 */
function PublishBar({ copy }: { copy: FaqWorkingCopy }) {
  const { t } = useTranslation();
  const publish = usePublishFaq();
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ahead = copy.revision > (copy.publication?.revision ?? 0);
  return (
    <div
      data-testid="faq-publish-bar"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {ahead ? (
          <Badge tone="warning">
            {copy.changedAt
              ? t('content.faq.unpublishedSince', { since: formatSince(copy.changedAt) })
              : t('content.unpublishedChanges')}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {copy.publication
            ? t('content.faq.published', {
                date: formatDate(copy.publication.publishedAt),
                items: copy.publication.items,
              })
            : t('content.faq.neverPublished')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setPreviewing(true)}>
          <EyeIcon />
          {t('content.faq.preview')}
        </Button>
        <Button size="sm" disabled={!ahead} onClick={() => setConfirming(true)}>
          <SendIcon />
          {t('content.faq.publish')}
        </Button>
      </div>
      <Dialog open={previewing} onOpenChange={setPreviewing}>
        {previewing && (
          <DialogContent closeLabel={t('common.close')} className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{t('content.faq.previewTitle')}</DialogTitle>
            </DialogHeader>
            <StorePreview>
              <FaqPreview copy={copy} />
            </StorePreview>
          </DialogContent>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('content.faq.publishTitle')}
        body={t('content.faq.publishBody')}
        action={t('content.faq.publish')}
        pending={publish.isPending}
        onConfirm={async () => {
          await publish.mutateAsync(copy.revision);
          toast.add({ title: t('content.faq.publishedToast'), type: 'success' });
        }}
        describeFailure={(error) =>
          errorCode(error) === 'CONTENT_STALE' ? t('content.faq.stale') : undefined
        }
      />
    </div>
  );
}

/** The FAQ as the store will show it (FQ5): unarchived sections with questions, in order. */
function FaqPreview({ copy }: { copy: FaqWorkingCopy }) {
  const { t } = useTranslation();
  const sections = copy.sections
    .filter((section) => !section.archivedAt)
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.archivedAt) }))
    .filter((section) => section.items.length > 0);
  return (
    <article className="flex flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold">{t('content.faq.storeTitle')}</h1>
      {sections.length === 0 && (
        <p className="text-muted-foreground">{t('content.faq.previewEmpty')}</p>
      )}
      {sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold">{section.title}</h2>
          {section.items.map((item) => (
            <details key={item.id} className="rounded-md border border-border bg-surface px-4">
              <summary className="flex min-h-12 cursor-pointer items-center font-medium">
                {item.question}
              </summary>
              <div className="pb-4">
                <RichPreview source={item.answer} />
              </div>
            </details>
          ))}
        </section>
      ))}
    </article>
  );
}
