import type { GameDetail, InputField } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TextCursorInputIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { useArchiveField, useReorderFields } from './catalog.queries';
import { catalogFailure, MoveButton } from './catalog-parts';
import { moved } from './catalog-search';
import { FieldDialog } from './field-dialog';

/**
 * "حقول الإدخال" (S06 screens): the game's fields in order (label, key, type, required), add and
 * edit, order (rule CT5), archive and restore (rules CT1, CT3).
 */
export function FieldsTab({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<InputField | 'new' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const reorder = useReorderFields(game.id);
  const archive = useArchiveField();
  const fields = game.fields.filter((field) => (field.archivedAt !== null) === archived);
  const live = game.fields.filter((field) => field.archivedAt === null);

  async function run(action: () => Promise<unknown>) {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(catalogFailure(t, error));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={archived ? 'archived' : 'live'}
          onValueChange={(value) => setArchived(value === 'archived')}
        >
          <TabsList className="w-auto">
            <TabsTrigger value="live">{t('catalog.filters.live')}</TabsTrigger>
            <TabsTrigger value="archived">{t('catalog.filters.archived')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => setEditing('new')} disabled={game.archivedAt !== null}>
          <PlusIcon />
          {t('catalog.inputFields.add')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {fields.length === 0 ? (
        <EmptyState
          icon={<TextCursorInputIcon />}
          title={archived ? t('catalog.inputFields.noneArchived') : t('catalog.inputFields.empty')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('catalog.inputFields.columns.label')}</TableHead>
              <TableHead>{t('catalog.inputFields.columns.key')}</TableHead>
              <TableHead>{t('catalog.inputFields.columns.type')}</TableHead>
              <TableHead>{t('catalog.inputFields.columns.required')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('catalog.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => (
              <TableRow key={field.id}>
                <TableCell className="font-medium">{field.labelAr}</TableCell>
                <TableCell>
                  <bdi dir="ltr" className="text-sm">
                    {field.key}
                  </bdi>
                </TableCell>
                <TableCell>{t(`catalog.inputFields.types.${field.type}`)}</TableCell>
                <TableCell>
                  {field.required ? (
                    <Badge tone="info">{t('catalog.inputFields.required')}</Badge>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('catalog.inputFields.optional')}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex items-center justify-end gap-1">
                    {archived ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={archive.isPending}
                        onClick={() =>
                          run(() => archive.mutateAsync({ id: field.id, archive: false }))
                        }
                      >
                        {t('catalog.actions.restore')}
                      </Button>
                    ) : (
                      <>
                        <MoveButton
                          label={t('catalog.order.up', { name: field.labelAr })}
                          disabled={reorder.isPending}
                          onClick={
                            index > 0
                              ? () =>
                                  run(() =>
                                    reorder.mutateAsync(
                                      moved(
                                        live.map((item) => item.id),
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
                          label={t('catalog.order.down', { name: field.labelAr })}
                          disabled={reorder.isPending}
                          onClick={
                            index < live.length - 1
                              ? () =>
                                  run(() =>
                                    reorder.mutateAsync(
                                      moved(
                                        live.map((item) => item.id),
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
                        <Button variant="outline" size="sm" onClick={() => setEditing(field)}>
                          {t('catalog.actions.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={archive.isPending}
                          onClick={() =>
                            run(() => archive.mutateAsync({ id: field.id, archive: true }))
                          }
                        >
                          {t('catalog.actions.archive')}
                        </Button>
                      </>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <FieldDialog
            gameId={game.id}
            field={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
