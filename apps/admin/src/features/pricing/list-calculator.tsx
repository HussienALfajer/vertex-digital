import { useQuery } from '@tanstack/react-query';
import type { MarginScope } from '@vertex-digital/contracts';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
} from '@vertex-digital/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allGamesQuery, categoriesQuery, gameQuery } from '../catalog/catalog.queries';
import { Picker } from './picker';
import { PricePreview } from './price-preview';
import { parseCostUsd } from './pricing-format';

/**
 * "جرّب تكلفة" (rule PR10, S20): what a list prices a cost at for a product, game or category. The
 * API computes it through the list's chain, capped as a stored row is.
 */
export function ListCalculator({ priceListId }: { priceListId: string }) {
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
      ? { target: { scope, targetId }, costUsdUnits: cost, priceListId }
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
              read={categories}
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
              read={games}
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
              read={gameId ? game : undefined}
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
