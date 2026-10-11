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
import { FormAlert } from '../../components/form-alert';
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
import { ScheduleText, StateBadge } from './content-parts';
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
  const reorder = useReorderBanners();
  const action = useBannerAction();
  const [editing, setEditing] = useState<Banner | 'new' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(request: () => Promise<unknown>) {
    setFailure(null);
    try {
      await request();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  if (banners.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (banners.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, banners.error)}</FormAlert>
        <Button variant="outline" onClick={() => banners.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const list = banners.data;
  const live = list.filter((banner) => !banner.archivedAt);
  const ids = live.map((banner) => banner.id);
  const enabled = live.filter((banner) => banner.enabled).length;
  const endedEnabled = live.some((banner) => banner.state === 'ended');
  const pending = reorder.isPending || action.isPending;
  const act = (id: string, verb: RowAction) => run(() => action.mutateAsync({ id, action: verb }));

  return (
    <div className="flex flex-col gap-6">
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
                            label={t('content.actions.moveUp')}
                            disabled={pending}
                            onClick={
                              index > 0
                                ? () => run(() => reorder.mutateAsync(moved(ids, index, index - 1)))
                                : undefined
                            }
                          >
                            <ArrowUpIcon />
                          </MoveButton>
                          <MoveButton
                            label={t('content.actions.moveDown')}
                            disabled={pending}
                            onClick={
                              index < ids.length - 1
                                ? () => run(() => reorder.mutateAsync(moved(ids, index, index + 1)))
                                : undefined
                            }
                          >
                            <ArrowDownIcon />
                          </MoveButton>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(banner)}>
                            <PencilIcon />
                            {t('content.actions.edit')}
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => void act(banner.id, archivedRow ? 'restore' : 'archive')}
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
          <BannerDialog
            banner={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
