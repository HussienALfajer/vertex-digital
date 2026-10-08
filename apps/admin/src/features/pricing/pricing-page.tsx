import { useQuery } from '@tanstack/react-query';
import {
  type Category,
  type MarginRule,
  type MarginScope,
  resolveMarginRule,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { PricePreview } from './price-preview';
import { rulesQuery } from './pricing.queries';
import { parseCostUsd } from './pricing-format';
import { RuleDialog } from './rule-dialog';
import { ArchiveRuleDialog, RuleFacts, RuleLine, type RuleTarget } from './rule-parts';

/**
 * "التسعير" (S06, F10): the global rule, the category rules, the game and product overrides, each
 * editable (re-authentication) and archivable but the global one, and a calculator for any cost.
 */
export function PricingPage() {
  const { t } = useTranslation();
  const rules = useQuery(rulesQuery);
  const categories = useQuery(categoriesQuery());
  const [editing, setEditing] = useState<RuleTarget | null>(null);
  const [archiving, setArchiving] = useState<MarginRule | null>(null);

  const loaded = rules.isSuccess && categories.isSuccess;
  const failed = rules.isError ? rules : categories.isError ? categories : null;
  const global = rules.data?.find((rule) => rule.scope === 'global');

  return (
    <>
      <PageHeader title={t('pricing.title')} description={t('pricing.subtitle')} />
      {!loaded && !failed && (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {failed && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, failed.error)}</FormAlert>
          <Button variant="outline" onClick={() => failed.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {loaded && global && (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>{t('pricing.global.title')}</CardTitle>
                <CardDescription>{t('pricing.global.description')}</CardDescription>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  setEditing({ scope: 'global', targetId: null, targetName: null, initial: global })
                }
              >
                {t('pricing.actions.edit')}
              </Button>
            </CardHeader>
            <RuleFacts rule={global} />
          </Card>
          <CategoryRules
            rules={rules.data}
            categories={categories.data}
            onEdit={setEditing}
            onArchive={setArchiving}
          />
          <Overrides rules={rules.data} onEdit={setEditing} onArchive={setArchiving} />
          <Calculator />
        </>
      )}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && <RuleDialog {...editing} onDone={() => setEditing(null)} />}
      </Dialog>
      <ArchiveRuleDialog rule={archiving} onClose={() => setArchiving(null)} />
    </>
  );
}

function CategoryRules({
  rules,
  categories,
  onEdit,
  onArchive,
}: {
  rules: MarginRule[];
  categories: Category[];
  onEdit: (target: RuleTarget) => void;
  onArchive: (rule: MarginRule) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="category-rules">
      <h2 id="category-rules" className="text-lg font-bold">
        {t('pricing.categories.title')}
      </h2>
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
            const own = rules.find(
              (rule) => rule.scope === 'category' && rule.targetId === category.id,
            );
            const inForce = resolveMarginRule(rules, { categoryId: category.id });
            return (
              <TableRow key={category.id}>
                <TableCell className="font-medium">{category.nameAr}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    <RuleLine rule={inForce} />
                    {!own && <Badge tone="neutral">{t('pricing.sources.global')}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">{own ? own.productCount : '—'}</TableCell>
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
                          initial: inForce,
                        })
                      }
                    >
                      {own ? t('pricing.actions.edit') : t('pricing.actions.customize')}
                    </Button>
                    {own && (
                      <Button variant="ghost" size="sm" onClick={() => onArchive(own)}>
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
    </section>
  );
}

/** The game and product rules (rule PR2), with the products each governs. */
function Overrides({
  rules,
  onEdit,
  onArchive,
}: {
  rules: MarginRule[];
  onEdit: (target: RuleTarget) => void;
  onArchive: (rule: MarginRule) => void;
}) {
  const { t } = useTranslation();
  const overrides = rules.filter((rule) => rule.scope === 'game' || rule.scope === 'product');
  return (
    <section className="flex flex-col gap-3" aria-labelledby="override-rules">
      <h2 id="override-rules" className="text-lg font-bold">
        {t('pricing.overrides.title')}
      </h2>
      {overrides.length === 0 ? (
        <EmptyState
          icon={<PercentIcon />}
          title={t('pricing.overrides.empty')}
          description={t('pricing.overrides.emptyHint')}
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

/** "جرّب تكلفة" (rule PR10): the rule in force for a product, game or category and a cost. */
function Calculator() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<MarginScope>('global');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [costText, setCostText] = useState('1.00');
  const categories = useQuery({ ...categoriesQuery(), enabled: scope === 'category' });
  const games = useQuery({ ...allGamesQuery, enabled: scope === 'game' || scope === 'product' });
  const game = useQuery({ ...gameQuery(gameId ?? ''), enabled: scope === 'product' && !!gameId });

  const targetId =
    scope === 'category'
      ? categoryId
      : scope === 'game'
        ? gameId
        : scope === 'product'
          ? productId
          : null;
  const cost = parseCostUsd(costText);
  const request =
    cost && (scope === 'global' || targetId)
      ? { target: { scope, targetId }, costUsdUnits: cost }
      : null;

  const scopes = (['global', 'category', 'game', 'product'] as const).map((value) => ({
    value,
    label: t(`pricing.scopes.${value}`),
  }));
  const products = (game.data?.products ?? []).filter((product) => !product.archivedAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.calculator.title')}</CardTitle>
        <CardDescription>{t('pricing.calculator.description')}</CardDescription>
      </CardHeader>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field>
          <FieldLabel render={<span />}>{t('pricing.calculator.scope')}</FieldLabel>
          <Picker
            label={t('pricing.calculator.scope')}
            items={scopes}
            value={scope}
            onChange={(value) => setScope(value as MarginScope)}
          />
        </Field>
        {scope === 'category' && (
          <Field>
            <FieldLabel render={<span />}>{t('pricing.scopes.category')}</FieldLabel>
            <Picker
              label={t('pricing.scopes.category')}
              placeholder={t('pricing.calculator.choose')}
              items={(categories.data ?? []).map((item) => ({
                value: item.id,
                label: item.nameAr,
              }))}
              value={categoryId}
              onChange={setCategoryId}
            />
          </Field>
        )}
        {(scope === 'game' || scope === 'product') && (
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
        )}
        {scope === 'product' && (
          <Field>
            <FieldLabel render={<span />}>{t('pricing.scopes.product')}</FieldLabel>
            <Picker
              label={t('pricing.scopes.product')}
              placeholder={t('pricing.calculator.choose')}
              items={products.map((item) => ({ value: item.id, label: item.nameAr }))}
              value={productId}
              onChange={setProductId}
            />
          </Field>
        )}
        <Field invalid={cost === null}>
          <FieldLabel>{t('pricing.calculator.cost')}</FieldLabel>
          <Input
            name="cost"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={costText}
            onChange={(event) => setCostText(event.target.value)}
          />
        </Field>
      </div>
      <PricePreview request={request} />
    </Card>
  );
}

/** A select over labelled values. */
function Picker({
  label,
  placeholder,
  items,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  items: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
