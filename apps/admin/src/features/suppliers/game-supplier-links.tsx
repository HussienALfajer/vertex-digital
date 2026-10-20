import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  CatalogImage,
  GameDetail,
  SupplierCategoryNode,
  SupplierCode,
} from '@vertex-digital/contracts';
import { Badge, Button, Card } from '@vertex-digital/ui';
import { ImageDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ActivateAllButton } from './activate-all';
import { Thumbnail } from './category-thumbnail';
import { gameCategoriesQuery, useCategoryChange, useCoverFromSupplier } from './suppliers.queries';

/**
 * The game page's supplier part (S16 SC9, SC10): "تفعيل الكل" and the supplier categories linked
 * to the game, each with "فك الربط" (the game, its packs and routes stay).
 */
export function GameSupplierLinks({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const linked = useQuery(gameCategoriesQuery(game.id));
  const [unlinking, setUnlinking] = useState<SupplierCategoryNode | null>(null);
  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-bold">{t('suppliers.gameLinks.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('suppliers.gameLinks.hint')}</p>
        </div>
        {game.archivedAt === null && <ActivateAllButton gameId={game.id} variant="outline" />}
      </div>
      {linked.isError && <FormAlert>{errorMessage(t, linked.error)}</FormAlert>}
      {linked.isSuccess &&
        (linked.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('suppliers.gameLinks.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {linked.data.map((node) => (
              <li
                key={`${node.supplierCode}:${node.categoryId}`}
                className="flex flex-wrap items-center gap-3 py-2"
              >
                <Thumbnail node={node} supplierCode={node.supplierCode} size="size-10" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    to="/suppliers/$code/categories/$categoryId"
                    params={{ code: node.supplierCode, categoryId: node.categoryId }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    <bdi>{node.name}</bdi>
                  </Link>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {t(`suppliers.names.${node.supplierCode}`)}
                    {node.path.length > 0 && <bdi>{node.path.join(' › ')}</bdi>}
                    {node.counts.newPacks > 0 && (
                      <Badge tone="gold">
                        {t('suppliers.catalog.newPacks', { count: node.counts.newPacks })}
                      </Badge>
                    )}
                    {node.missingSince && (
                      <Badge tone="danger">{t('suppliers.gameLinks.missing')}</Badge>
                    )}
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => setUnlinking(node)}>
                  {t('suppliers.catalog.unlink')}
                </Button>
              </li>
            ))}
          </ul>
        ))}
      {unlinking && <UnlinkDialog node={unlinking} onClose={() => setUnlinking(null)} />}
    </Card>
  );
}

function UnlinkDialog({ node, onClose }: { node: SupplierCategoryNode; onClose: () => void }) {
  const { t } = useTranslation();
  const change = useCategoryChange(node.supplierCode);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={t('suppliers.gameLinks.unlinkTitle')}
      body={t('suppliers.gameLinks.unlinkBody', { name: node.name })}
      action={t('suppliers.catalog.unlink')}
      destructive
      pending={change.isPending}
      onConfirm={async () => {
        await change.mutateAsync({ categoryId: node.categoryId, change: 'unlink' });
      }}
    />
  );
}

/**
 * Rule IM3, S19 D10: "صورة <المورد>" beside the cover, one per supplier with a linked category
 * that has an image: the API downloads it again and stores it as a new cover. The admin picks;
 * a cover never changes on its own.
 */
export function SupplierCoverButton({
  gameId,
  onCover,
}: {
  gameId: string;
  onCover: (cover: CatalogImage | null) => void;
}) {
  const { t } = useTranslation();
  const linked = useQuery(gameCategoriesQuery(gameId));
  const cover = useCoverFromSupplier(gameId);
  const [pending, setPending] = useState<SupplierCode | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const sources = (linked.data ?? [])
    .filter((item) => item.hasImage && !item.missingSince)
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.supplierCode === item.supplierCode) === index,
    );
  if (sources.length === 0) return null;

  async function use(source: SupplierCategoryNode) {
    setFailure(null);
    setPending(source.supplierCode);
    try {
      const game = await cover.mutateAsync({
        supplier: source.supplierCode,
        categoryId: source.categoryId,
      });
      onCover(game.cover);
    } catch (error) {
      setFailure(errorMessage(t, error));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {sources.map((source) => (
          <Button
            key={source.supplierCode}
            type="button"
            variant="outline"
            size="sm"
            disabled={cover.isPending}
            onClick={() => use(source)}
          >
            <ImageDownIcon />
            {pending === source.supplierCode
              ? t('suppliers.gameLinks.coverPending')
              : t('suppliers.gameLinks.cover', {
                  supplier: t(`suppliers.names.${source.supplierCode}`),
                })}
          </Button>
        ))}
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
    </div>
  );
}
