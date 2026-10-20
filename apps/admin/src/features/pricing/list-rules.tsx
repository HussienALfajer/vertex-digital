import { useQueries, useQuery } from '@tanstack/react-query';
import {
  type Category,
  type MarginRule,
  type PricingPath,
  resolveListEntry,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldLabel,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { PercentIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { allGamesQuery, categoriesQuery, gameQuery } from '../catalog/catalog.queries';
import { Picker } from './picker';
import { listRulesQuery } from './pricing.queries';
import { RuleDialog } from './rule-dialog';
import { ArchiveRuleDialog, RuleFacts, RuleLine, type RuleTarget } from './rule-parts';

/** A list of a chain (S20 LS3): the list first, then its parents. */
export interface ChainList {
  id: string;
  kind: string;
  name: string;
}

/**
 * A list's rules (S06 PR2, S20 LS2, LS4): its global rule, the category rules and its game and
 * product overrides, each editable (re-authentication) and archivable but a root list's global
 * one. Where the list has no rule of its own, the rule in force comes from the nearest list of its
 * chain, and says so.
 */
export function ListRules({ chain }: { chain: readonly ChainList[] }) {
  const { t } = useTranslation();
  const list = chain[0] as ChainList;
  const reads = useQueries({ queries: chain.map((item) => listRulesQuery(item.id)) });
  const categories = useQuery(categoriesQuery());
  const [editing, setEditing] = useState<RuleTarget | null>(null);
  const [archiving, setArchiving] = useState<MarginRule | null>(null);
  const [picking, setPicking] = useState(false);

  const failed = [...reads, categories].find((read) => read.isError);
  if (failed) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, failed.error)}</FormAlert>
        <Button variant="outline" onClick={() => failed.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!categories.isSuccess || reads.some((read) => !read.isSuccess)) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const all = reads.flatMap((read) => read.data ?? []);
  const own = all.filter((rule) => rule.priceListId === list.id);
  const ids = chain.map((item) => item.id);
  const inForce = (path: PricingPath) =>
    resolveListEntry(
      ids,
      { rules: all, fixedPrices: [] },
      { ...path, productId: path.productId ?? '' },
    ).rule;
  const global = own.find((rule) => rule.scope === 'global');
  const globalInForce = inForce({});
  const fromList = (rule: MarginRule) => chain.find((item) => item.id === rule.priceListId);
  const target = (values: Omit<RuleTarget, 'priceListId'>): RuleTarget => ({
    ...values,
    priceListId: list.id,
  });

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{t('pricing.global.title')}</CardTitle>
            <CardDescription>
              {list.kind === 'custom'
                ? t('pricing.global.customDescription')
                : t('pricing.global.description')}
            </CardDescription>
          </div>
          <span className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                setEditing(
                  target({
                    scope: 'global',
                    targetId: null,
                    targetName: null,
                    initial: globalInForce,
                  }),
                )
              }
            >
              {global ? t('pricing.actions.edit') : t('pricing.actions.customize')}
            </Button>
            {global && list.kind === 'custom' && (
              <Button variant="ghost" onClick={() => setArchiving(global)}>
                {t('pricing.actions.archive')}
              </Button>
            )}
          </span>
        </CardHeader>
        {!global && (
          <p className="text-sm text-muted-foreground">
            {t('pricing.inherited', { name: fromList(globalInForce)?.name ?? '' })}
          </p>
        )}
        <RuleFacts rule={globalInForce} />
      </Card>
      <section className="flex flex-col gap-3" aria-labelledby="category-rules">
        <h2 id="category-rules" className="text-lg font-bold">
          {t('pricing.categories.title')}
        </h2>
        <CategoryRules
          categories={categories.data}
          own={own}
          inForce={inForce}
          sourceOf={(rule) =>
            rule.priceListId !== list.id
              ? t('pricing.sources.list', { name: fromList(rule)?.name ?? '' })
              : rule.scope === 'global'
                ? t('pricing.sources.global')
                : null
          }
          onEdit={(values) => setEditing(target(values))}
          onArchive={setArchiving}
        />
      </section>
      <Overrides
        rules={own}
        onAdd={list.kind === 'retail' ? undefined : () => setPicking(true)}
        onEdit={(values) => setEditing(target(values))}
        onArchive={setArchiving}
      />
      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <TargetDialog
            onPick={(picked) => {
              setPicking(false);
              setEditing(target({ ...picked, initial: inForce(picked.path) }));
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && <RuleDialog {...editing} onDone={() => setEditing(null)} />}
      </Dialog>
      <ArchiveRuleDialog rule={archiving} onClose={() => setArchiving(null)} />
    </>
  );
}

function CategoryRules({
  categories,
  own,
  inForce,
  sourceOf,
  onEdit,
  onArchive,
}: {
  categories: Category[];
  own: MarginRule[];
  inForce: (path: PricingPath) => MarginRule;
  /** Where an inherited rule comes from; null for the category's own. */
  sourceOf: (rule: MarginRule) => string | null;
  onEdit: (target: Omit<RuleTarget, 'priceListId'>) => void;
  onArchive: (rule: MarginRule) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('pricing.columns.category')}</TableHead>
          <TableHead>{t('pricing.columns.rule')}</TableHead>
          <TableHead>{t('pricing.columns.products')}</TableHead>
          <TableHead>
            <span className="sr-only">{t('pricing.columns.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {categories.map((category) => {
          const rule = own.find(
            (candidate) => candidate.scope === 'category' && candidate.targetId === category.id,
          );
          const applied = inForce({ categoryId: category.id });
          const source = rule ? null : sourceOf(applied);
          return (
            <TableRow key={category.id}>
              <TableCell className="font-medium">{category.nameAr}</TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-2">
                  <RuleLine rule={applied} />
                  {source && <Badge tone="neutral">{source}</Badge>}
                </span>
              </TableCell>
              <TableCell className="tabular-nums">{rule ? rule.productCount : '—'}</TableCell>
              <TableCell>
                <span className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onEdit({
                        scope: 'category',
                        targetId: category.id,
                        targetName: category.nameAr,
                        initial: applied,
                      })
                    }
                  >
                    {rule ? t('pricing.actions.edit') : t('pricing.actions.customize')}
                  </Button>
                  {rule && (
                    <Button variant="ghost" size="sm" onClick={() => onArchive(rule)}>
                      {t('pricing.actions.archive')}
                    </Button>
                  )}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** A list's own game and product rules (rule PR2), with the products each governs. */
function Overrides({
  rules,
  onAdd,
  onEdit,
  onArchive,
}: {
  rules: MarginRule[];
  /** A list but retail adds them here; retail's are set from the game's page. */
  onAdd?: () => void;
  onEdit: (target: Omit<RuleTarget, 'priceListId'>) => void;
  onArchive: (rule: MarginRule) => void;
}) {
  const { t } = useTranslation();
  const overrides = rules.filter((rule) => rule.scope === 'game' || rule.scope === 'product');
  return (
    <section className="flex flex-col gap-3" aria-labelledby="override-rules">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="override-rules" className="text-lg font-bold">
          {t('pricing.overrides.title')}
        </h2>
        {onAdd && (
          <Button variant="outline" onClick={onAdd}>
            {t('pricing.overrides.add')}
          </Button>
        )}
      </div>
      {overrides.length === 0 ? (
        <EmptyState
          icon={<PercentIcon />}
          title={t('pricing.overrides.empty')}
          description={
            onAdd ? t('pricing.overrides.emptyListHint') : t('pricing.overrides.emptyHint')
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('pricing.columns.target')}</TableHead>
              <TableHead>{t('pricing.columns.rule')}</TableHead>
              <TableHead>{t('pricing.columns.products')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('pricing.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overrides.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="whitespace-normal">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.targetName}</span>
                    <Badge tone="info">{t(`pricing.scopes.${rule.scope}`)}</Badge>
                    {rule.targetArchived && (
                      <Badge tone="warning">{t('pricing.overrides.targetArchived')}</Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <RuleLine rule={rule} />
                </TableCell>
                <TableCell className="tabular-nums">{rule.productCount}</TableCell>
                <TableCell>
                  <span className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onEdit({
                          scope: rule.scope,
                          targetId: rule.targetId,
                          targetName: rule.targetName,
                          initial: rule,
                        })
                      }
                    >
                      {t('pricing.actions.edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onArchive(rule)}>
                      {t('pricing.actions.archive')}
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** A game, or one of its packs, for a list's own rule. */
function TargetDialog({
  onPick,
}: {
  onPick: (target: {
    scope: 'game' | 'product';
    targetId: string;
    targetName: string;
    path: PricingPath;
  }) => void;
}) {
  const { t } = useTranslation();
  const [gameId, setGameId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const games = useQuery(allGamesQuery);
  const game = useQuery({ ...gameQuery(gameId ?? ''), enabled: !!gameId });
  const products = (game.data?.products ?? []).filter((product) => !product.archivedAt);

  function pick() {
    if (!game.data) return;
    const path = { gameId: game.data.id, categoryId: game.data.categoryId };
    const product = products.find((item) => item.id === productId);
    onPick(
      product
        ? {
            scope: 'product',
            targetId: product.id,
            targetName: product.nameAr,
            path: { ...path, productId: product.id },
          }
        : { scope: 'game', targetId: game.data.id, targetName: game.data.nameAr, path },
    );
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('pricing.overrides.add')}</DialogTitle>
        <DialogDescription>{t('pricing.overrides.addHint')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel render={<span />}>{t('pricing.scopes.game')}</FieldLabel>
          <Picker
            label={t('pricing.scopes.game')}
            placeholder={t('pricing.calculator.choose')}
            items={(games.data?.items ?? []).map((item) => ({
              value: item.id,
              label: item.nameAr,
            }))}
            value={gameId}
            onChange={(value) => {
              setGameId(value);
              setProductId(null);
            }}
          />
        </Field>
        <Field>
          <FieldLabel render={<span />}>{t('pricing.overrides.productOptional')}</FieldLabel>
          <Picker
            label={t('pricing.overrides.productOptional')}
            placeholder={t('pricing.overrides.wholeGame')}
            items={products.map((item) => ({ value: item.id, label: item.nameAr }))}
            value={productId}
            onChange={setProductId}
          />
        </Field>
      </div>
      <DialogFooter>
        <Button disabled={!game.data} onClick={pick}>
          {t('pricing.overrides.next')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
