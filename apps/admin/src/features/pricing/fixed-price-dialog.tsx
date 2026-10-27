import { useQuery } from '@tanstack/react-query';
import {
  formatAmountInput,
  formatUsd,
  listPrice,
  type MarginRule,
  marginBasisPoints,
  parseUsd,
  ROOT_PRICE_LIST_IDS,
  resolveListEntry,
  setFixedPriceSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { allGamesQuery, gameQuery } from '../catalog/catalog.queries';
import { Picker } from './picker';
import { priceMatrixQuery, useSetFixedPrice } from './pricing.queries';
import { formatPercentBp } from './pricing-format';

/**
 * A list's fixed price for a pack (S20 LS2, LP1): the pack, the price, and before saving the price
 * the list will take at today's cost: the fixed price when it covers the cost and the guarding
 * rule's minimum margin, else the rule's price ("احتياطي"), capped at retail (LP2).
 */
export function FixedPriceDialog({
  listId,
  chain,
  rules,
  initial,
  onDone,
}: {
  listId: string;
  /** The list's chain, the list first (LS3). */
  chain: readonly string[];
  /** The live rules of every list of the chain. */
  rules: MarginRule[];
  initial?: { gameId: string; productId: string; priceUsdUnits: number | null };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSetFixedPrice();
  const [gameId, setGameId] = useState<string | null>(initial?.gameId ?? null);
  const [productId, setProductId] = useState<string | null>(initial?.productId ?? null);
  const [priceText, setPriceText] = useState(
    initial?.priceUsdUnits ? formatAmountInput('USD', initial.priceUsdUnits) : '',
  );
  const [invalid, setInvalid] = useState<'product' | 'price' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const games = useQuery(allGamesQuery);
  const game = useQuery({ ...gameQuery(gameId ?? ''), enabled: !!gameId });
  const matrix = useQuery(priceMatrixQuery({ gameId: gameId ?? undefined, lists: [listId] }));

  const price = parseUsd(priceText);
  const valid = price !== null && setFixedPriceSchema.safeParse({ priceUsdUnits: price }).success;
  const row = matrix.data?.rows.find((candidate) => candidate.productId === productId);
  const retailCell = row?.cells.find((cell) => cell.priceListId === ROOT_PRICE_LIST_IDS.retail);
  const result =
    row?.costUsdUnits && valid && game.data && productId
      ? listPrice(
          row.costUsdUnits,
          {
            fixedPriceUsdUnits: price,
            rule: resolveListEntry(
              chain,
              { rules, fixedPrices: [] },
              { productId, gameId: game.data.id, categoryId: game.data.categoryId },
            ).rule,
          },
          listId !== ROOT_PRICE_LIST_IDS.retail && retailCell?.priceUsdUnits
            ? { priceUsdUnits: retailCell.priceUsdUnits, minMarginUsdUnits: 0 }
            : null,
        )
      : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    if (!productId) return setInvalid('product');
    if (!valid || price === null) return setInvalid('price');
    setInvalid(null);
    try {
      await save.mutateAsync({ listId, productId, priceUsdUnits: price });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const products = (game.data?.products ?? []).filter((product) => !product.archivedAt);
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('pricing.fixed.title')}</DialogTitle>
        <DialogDescription>{t('pricing.fixed.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
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
          <Field invalid={invalid === 'product'}>
            <FieldLabel render={<span />}>{t('pricing.scopes.product')}</FieldLabel>
            <Picker
              label={t('pricing.scopes.product')}
              placeholder={t('pricing.calculator.choose')}
              items={products.map((item) => ({ value: item.id, label: item.nameAr }))}
              value={productId}
              onChange={setProductId}
            />
            <FieldError match={invalid === 'product'}>
              {t('pricing.fixed.productRequired')}
            </FieldError>
          </Field>
        </div>
        <Field invalid={invalid === 'price'}>
          <FieldLabel>{t('pricing.fixed.price')}</FieldLabel>
          <Input
            name="price"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
          />
          <FieldError match={invalid === 'price'}>{t('pricing.fixed.priceInvalid')}</FieldError>
        </Field>
        {productId && (
          <section
            className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm"
            aria-labelledby="fixed-result"
          >
            <h3 id="fixed-result" className="text-base font-bold">
              {t('pricing.fixed.result')}
            </h3>
            {matrix.isPending ? (
              <Skeleton className="h-10 w-full" />
            ) : matrix.isError ? (
              // Audit A05-35: a failed read is not "no cost".
              <div className="flex flex-col items-start gap-2">
                <FormAlert>{errorMessage(t, matrix.error)}</FormAlert>
                <Button variant="outline" size="sm" onClick={() => matrix.refetch()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : !row?.costUsdUnits ? (
              <p className="text-muted-foreground">{t('pricing.fixed.noCost')}</p>
            ) : result ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-bold tabular-nums">
                  {ltr(formatUsd(result.priceUsdUnits))}
                </span>
                <SourceBadge source={result.source} />
                <span className="text-muted-foreground">
                  {t('pricing.fixed.margin', {
                    cost: ltr(formatUsd(row.costUsdUnits)),
                    margin: ltr(formatUsd(result.priceUsdUnits - row.costUsdUnits)),
                    percent: ltr(
                      `${formatPercentBp(marginBasisPoints(result.priceUsdUnits, row.costUsdUnits))}%`,
                    ),
                  })}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground">{t('pricing.fixed.enterPrice')}</p>
            )}
            {/* Audit A05-34: the price the list will not take is said before saving. */}
            {result && price !== null && result.source !== 'fixed' && result.source !== 'rule' && (
              <Callout
                tone="warning"
                title={t(`pricing.fixed.warnings.${result.source}`, {
                  fixed: ltr(formatUsd(price)),
                  price: ltr(formatUsd(result.priceUsdUnits)),
                })}
              />
            )}
          </section>
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending
              ? t('pricing.form.saving')
              : result && result.source !== 'fixed' && result.source !== 'rule'
                ? t('pricing.fixed.saveAnyway')
                : t('pricing.fixed.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

const SOURCE_TONES = {
  rule: 'neutral',
  fixed: 'info',
  fixed_fallback: 'warning',
  retail_cap: 'gold',
} as const;

/** Where a list's price comes from (LP1, LP2): قاعدة، ثابت، احتياطي، سقف التجزئة. */
export function SourceBadge({ source }: { source: keyof typeof SOURCE_TONES }) {
  const { t } = useTranslation();
  return <Badge tone={SOURCE_TONES[source]}>{t(`pricing.priceSources.${source}`)}</Badge>;
}
