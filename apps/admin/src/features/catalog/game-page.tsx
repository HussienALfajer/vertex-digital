import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { GameDetail } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { ArchiveIcon, ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { GamePricing } from '../pricing/game-pricing';
import { gameQuery, useArchiveGame } from './catalog.queries';
import { StatusBadge } from './catalog-parts';
import { FieldsTab } from './fields-tab';
import { GameForm } from './game-form';
import { ProductsTab } from './products-tab';

export const GAME_TABS = ['data', 'fields', 'products', 'pricing'] as const;

export type GameTab = (typeof GAME_TABS)[number];

/** "/catalog/games/new" (S06 screens): the data tab only, until the game exists. */
export function NewGamePage({ categoryId }: { categoryId?: string }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        title={t('catalog.game.newTitle')}
        description={t('catalog.game.newSubtitle')}
        actions={<BackLink />}
      />
      <GameForm categoryId={categoryId} />
    </>
  );
}

/**
 * A game or app (S06 screens): its data, input fields, products and pricing in tabs, the tab in
 * the URL; archive and restore (rule CT1).
 */
export function GamePage({
  id,
  tab,
  onTab,
}: {
  id: string;
  tab: GameTab;
  onTab: (tab: GameTab) => void;
}) {
  const { t } = useTranslation();
  const game = useQuery(gameQuery(id));

  if (game.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (game.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, game.error)}</FormAlert>
        <Button variant="outline" onClick={() => game.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const data = game.data;
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {data.nameAr}
            <StatusBadge status={data.status} />
            {data.archivedAt && <Badge tone="warning">{t('catalog.archived')}</Badge>}
          </span>
        }
        description={<bdi dir="ltr">{data.nameEn}</bdi>}
        actions={
          <>
            <BackLink />
            <ArchiveGame game={data} />
          </>
        }
      />
      {data.archivedAt && (
        <Callout
          tone="warning"
          icon={<ArchiveIcon />}
          title={t('catalog.game.archivedTitle')}
          description={
            data.categoryArchived
              ? t('catalog.game.archivedCategory')
              : t('catalog.game.archivedHint')
          }
        />
      )}
      <Tabs value={tab} onValueChange={(value) => onTab(value as GameTab)}>
        <TabsList>
          {GAME_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`catalog.game.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="data">
          <GameForm game={data} />
        </TabsContent>
        <TabsContent value="fields">
          <FieldsTab game={data} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsTab game={data} />
        </TabsContent>
        <TabsContent value="pricing">
          <GamePricing game={data} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" render={<Link to="/catalog" />}>
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {t('catalog.game.back')}
    </Button>
  );
}

/** Archive, or restore (`PARENT_ARCHIVED` while its category is archived, rule CT1). */
function ArchiveGame({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const archive = useArchiveGame(game.id);
  const [open, setOpen] = useState(false);
  const archived = game.archivedAt !== null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {archived ? t('catalog.actions.restore') : t('catalog.actions.archive')}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={archived ? t('catalog.game.restoreTitle') : t('catalog.game.archiveTitle')}
        body={
          archived
            ? t('catalog.game.restoreBody', { name: game.nameAr })
            : t('catalog.game.archiveBody', { name: game.nameAr })
        }
        action={archived ? t('catalog.actions.restore') : t('catalog.actions.archive')}
        destructive={!archived}
        pending={archive.isPending}
        onConfirm={async () => {
          await archive.mutateAsync(!archived);
        }}
      />
    </>
  );
}
