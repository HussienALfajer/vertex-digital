import { useQuery } from '@tanstack/react-query';
import {
  BANNERS_ENABLED_MAX,
  BANNERS_MAX,
  type Banner,
  catalogImagePath,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ImageIcon,
  PencilIcon,
  PlusIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { ReadFailure } from '../../components/read-failure';
import { useVisibleAgain } from '../../lib/admin-stream';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { MoveButton } from '../catalog/catalog-parts';
import { BannerDialog } from './banner-dialog';
import {
  bannersQuery,
  type RowAction,
  useBannerAction,
  useReorderBanners,
} from './content.queries';
import { reorderFailure, ScheduleText, StaleRead, StateBadge } from './content-parts';
import { moved } from './faq-order';

/**
 * "البانرات" (S14 BN1–BN6): the banners in their order with the thumbnail, link, schedule, state,
 * the enable switch, move up and down, edit, archive and restore; "N من 5 مفعّلة".
 */
export function BannersPage({
  archived,
  onArchived,
}: {
  archived: boolean;
  onArchived: (archived: boolean) => void;
}) {
  const { t } = useTranslation();
  const archivedId = useId();
  const banners = useQuery(bannersQuery(archived));
  // States follow the clock (scheduled, live, ended): read again when the tab is seen (A08-23).
  useVisibleAgain(() => void banners.refetch());
  const reorder = useReorderBanners();
  const action = useBannerAction();
  const [editing, setEditing] = useState<Banner | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Banner | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(request: () => Promise<unknown>, describe = errorMessage) {
    setFailure(null);
    try {
      await request();
    } catch (error) {
      setFailure(describe(t, error));
    }
  }

  if (banners.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (!banners.data) {
    return <ReadFailure error={banners.error} onRetry={() => banners.refetch()} />;
  }
  const list = banners.data;
  const live = list.filter((banner) => !banner.archivedAt);
  const ids = live.map((banner) => banner.id);
  const enabled = live.filter((banner) => banner.enabled).length;
  const endedEnabled = live.some((banner) => banner.state === 'ended');
  const pending = reorder.isPending || action.isPending;
  const act = (id: string, verb: RowAction) => run(() => action.mutateAsync({ id, action: verb }));
  const move = (from: number, to: number) =>
    run(() => reorder.mutateAsync(moved(ids, from, to)), reorderFailure);

  return (
    <div className="flex flex-col gap-6">
      {banners.isError && <StaleRead onRetry={() => banners.refetch()} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Badge
            tone={enabled >= BANNERS_ENABLED_MAX ? 'warning' : 'neutral'}
            className="tabular-nums"
          >
            {t('content.banners.enabledCount', { count: enabled, max: BANNERS_ENABLED_MAX })}
          </Badge>
          <label htmlFor={archivedId} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id={archivedId}
              checked={archived}
              onCheckedChange={(value) => onArchived(value)}
            />
            {t('content.archivedToggle')}
          </label>
        </div>
        <Button disabled={live.length >= BANNERS_MAX} onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('content.banners.add')}
        </Button>
      </div>
      {endedEnabled && (
        <p className="text-sm text-muted-foreground">{t('content.banners.endedHint')}</p>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      {list.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          title={t('content.banners.empty')}
          action={<Button onClick={() => setEditing('new')}>{t('content.banners.add')}</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('content.banners.image')}</TableHead>
              <TableHead>{t('content.banners.alt')}</TableHead>
              <TableHead>{t('content.banners.schedule')}</TableHead>
              <TableHead>{t('content.banners.state')}</TableHead>
              <TableHead>{t('content.banners.enabled')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('content.banners.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((banner) => {
              const index = ids.indexOf(banner.id);
              const archivedRow = !!banner.archivedAt;
              const name = { name: banner.altText };
              return (
                <TableRow key={banner.id} data-testid="banner-row">
                  <TableCell>
                    <img
                      src={catalogImagePath(banner.imageFileId)}
                      alt=""
                      className="aspect-[2/1] w-28 rounded-sm border border-border object-cover"
                    />
                  </TableCell>
                  <TableCell>
                    <span className="block">{banner.altText}</span>
                    {banner.linkPath && (
                      <span className="block text-sm text-muted-foreground">
                        {ltr(banner.linkPath)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    <ScheduleText startsAt={banner.startsAt} endsAt={banner.endsAt} />
                  </TableCell>
                  <TableCell>
                    <StateBadge state={banner.state} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={t('content.banners.enableLabel', { name: banner.altText })}
                      checked={banner.enabled}
                      disabled={archivedRow || pending}
                      onCheckedChange={(value) => void act(banner.id, value ? 'enable' : 'disable')}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {!archivedRow && (
                        <>
                          <MoveButton
                            label={t('content.actions.moveUpNamed', name)}
                            disabled={pending}
                            onClick={index > 0 ? () => move(index, index - 1) : undefined}
                          >
                            <ArrowUpIcon />
                          </MoveButton>
                          <MoveButton
                            label={t('content.actions.moveDownNamed', name)}
                            disabled={pending}
                            onClick={
                              index < ids.length - 1 ? () => move(index, index + 1) : undefined
                            }
                          >
                            <ArrowDownIcon />
                          </MoveButton>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-11"
                            aria-label={t('content.actions.editNamed', name)}
                            onClick={() => setEditing(banner)}
                          >
                            <PencilIcon />
                            {t('content.actions.edit')}
                          </Button>
                        </>
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
                        disabled={pending}
                        onClick={() =>
                          archivedRow ? void act(banner.id, 'restore') : setArchiving(banner)
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
      {/* BN5: archiving takes a live banner off the store; a restore brings it back off, last. */}
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={t('content.banners.archiveTitle', { name: archiving?.altText ?? '' })}
        body={
          archiving?.state === 'live'
            ? t('content.banners.archiveLiveBody')
            : t('content.banners.archiveBody')
        }
        action={t('content.actions.archive')}
        destructive
        pending={action.isPending}
        onConfirm={async () => {
          if (archiving) await action.mutateAsync({ id: archiving.id, action: 'archive' });
        }}
      />
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <BannerDialog
            banner={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
