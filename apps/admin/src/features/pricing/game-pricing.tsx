import { useQuery } from '@tanstack/react-query';
import { type GameDetail, type MarginRule, resolveMarginRule } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ruleSource } from './price-preview';
import { rulesQuery } from './pricing.queries';
import { RuleDialog } from './rule-dialog';
import { ArchiveRuleDialog, RuleFacts, RuleLine, type RuleTarget } from './rule-parts';

/**
 * A game's "التسعير" tab (S06 screens): the rule that applies to the game and where it comes from
 * (rule PR2), its own rule to set or archive, and per product the rule in force with "تخصيص".
 */
export function GamePricing({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const rules = useQuery(rulesQuery);
  const [editing, setEditing] = useState<RuleTarget | null>(null);
  const [archiving, setArchiving] = useState<MarginRule | null>(null);

  if (rules.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (rules.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, rules.error)}</FormAlert>
        <Button variant="outline" onClick={() => rules.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const path = { gameId: game.id, categoryId: game.categoryId };
  const inForce = resolveMarginRule(rules.data, path);
  const own = inForce.scope === 'game' ? inForce : null;
  const products = game.products.filter((product) => product.archivedAt === null);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{t('pricing.game.title')}</CardTitle>
            <CardDescription>
              {t('pricing.preview.from', { source: ruleSource(t, inForce.scope) })}
            </CardDescription>
          </div>
          <span className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                setEditing({
                  scope: 'game',
                  targetId: game.id,
                  targetName: game.nameAr,
                  initial: inForce,
                })
              }
            >
              {own ? t('pricing.actions.edit') : t('pricing.game.customize')}
            </Button>
            {own && (
              <Button variant="ghost" onClick={() => setArchiving(own)}>
                {t('pricing.actions.archive')}
              </Button>
            )}
          </span>
        </CardHeader>
        <RuleFacts rule={inForce} />
      </Card>
      <section className="flex flex-col gap-3" aria-labelledby="product-rules">
        <h2 id="product-rules" className="text-lg font-bold">
          {t('pricing.game.products')}
        </h2>
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pricing.game.noProducts')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pricing.columns.product')}</TableHead>
                <TableHead>{t('pricing.columns.rule')}</TableHead>
                <TableHead>{t('pricing.columns.source')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('pricing.columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => {
                const rule = resolveMarginRule(rules.data, { ...path, productId: product.id });
                const productOwn = rule.scope === 'product' ? rule : null;
                return (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">
                      <bdi>{product.nameAr}</bdi>
                    </TableCell>
                    <TableCell>
                      <RuleLine rule={rule} />
                    </TableCell>
                    <TableCell>
                      <Badge tone={productOwn ? 'info' : 'neutral'}>
                        {ruleSource(t, rule.scope)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setEditing({
                              scope: 'product',
                              targetId: product.id,
                              targetName: product.nameAr,
                              initial: rule,
                            })
                          }
                        >
                          {productOwn ? t('pricing.actions.edit') : t('pricing.actions.customize')}
                        </Button>
                        {productOwn && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setArchiving(productOwn)}
                          >
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
        )}
      </section>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && <RuleDialog {...editing} onDone={() => setEditing(null)} />}
      </Dialog>
      <ArchiveRuleDialog rule={archiving} onClose={() => setArchiving(null)} />
    </div>
  );
}
