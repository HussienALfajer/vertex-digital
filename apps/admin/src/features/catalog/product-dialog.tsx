import {
  AMOUNT_STEP,
  amountOfQuantity,
  CURRENCY_SCALE,
  createProductSchema,
  DEFAULT_AMOUNT_UNIT_AR,
  DEFAULT_MAX_QUANTITY,
  MAX_AMOUNT_UNITS,
  PRODUCT_KINDS,
  type Product,
  type ProductKind,
  parseUsd,
  updateProductSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { useCreateProduct, useUpdateProduct } from './catalog.queries';
import { catalogFailure } from './catalog-parts';

const PRODUCT_FIELDS = [
  'nameAr',
  'gameAmount',
  'officialPriceUsdUnits',
  'maxQuantity',
  'minQuantity',
  'amountUnitAr',
  'regionAr',
  'redemptionAr',
] as const;

type ProductField = (typeof PRODUCT_FIELDS)[number];

/** A whole number typed, null when empty, NaN when not a number (the schema refuses it). */
const integer = (text: string) =>
  text === '' ? null : /^\d+$/.test(text) ? Number(text) : Number.NaN;

/**
 * S25 AM1: a face amount typed in the unit (`7,300`), as units of `AMOUNT_STEP`; NaN when it is
 * not a whole number of steps (the schema refuses it).
 */
const amountUnits = (text: string) => {
  const amount = integer(text.replace(/[,\s]/g, ''));
  return amount === null || amount % AMOUNT_STEP !== 0 ? Number.NaN : amount / AMOUNT_STEP;
};

/** A price as the form shows it: `0.99`. */
const dollars = (units: number) => (units / CURRENCY_SCALE.USD).toFixed(2);

/**
 * Add or edit a product (rule CT8): the kind is fixed at creation; region and redemption
 * instructions for codes only; the max quantity starts at 1 for direct top-ups and 10 for codes.
 * S25 AM1: an `amount` product takes its unit and its smallest and largest amount, typed in the
 * unit in steps of 100 and sent as units.
 */
export function ProductDialog({
  gameId,
  product,
  onDone,
}: {
  gameId: string;
  /** Null to add a product. */
  product: Product | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateProduct(gameId);
  const update = useUpdateProduct();
  const [kind, setKind] = useState<ProductKind>(product?.kind ?? 'direct');
  const [maxQuantity, setMaxQuantity] = useState(
    String(product?.maxQuantity ?? DEFAULT_MAX_QUANTITY.direct),
  );
  const [minAmount, setMinAmount] = useState(
    String(amountOfQuantity(product?.kind === 'amount' ? product.minQuantity : 10)),
  );
  const [maxAmount, setMaxAmount] = useState(
    String(amountOfQuantity(product?.kind === 'amount' ? product.maxQuantity : MAX_AMOUNT_UNITS)),
  );
  const { ref, focusInvalid } = useFocusInvalid();
  const [errors, setErrors] = useState<Partial<Record<ProductField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  function changeKind(next: ProductKind) {
    // The default follows the kind until the admin types another value.
    if (maxQuantity === String(DEFAULT_MAX_QUANTITY[kind])) {
      setMaxQuantity(String(DEFAULT_MAX_QUANTITY[next]));
    }
    setKind(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const official = text('officialPrice');
    const values = {
      nameAr: text('nameAr'),
      gameAmount: integer(text('gameAmount')),
      officialPriceUsdUnits: official === '' ? null : (parseUsd(official) ?? Number.NaN),
      ...(kind === 'amount'
        ? {
            minQuantity: amountUnits(minAmount.trim()),
            maxQuantity: amountUnits(maxAmount.trim()),
            amountUnitAr: text('amountUnitAr'),
          }
        : { maxQuantity: integer(maxQuantity.trim()) ?? Number.NaN }),
      ...(kind === 'code'
        ? { regionAr: text('regionAr') || null, redemptionAr: text('redemptionAr') || null }
        : {}),
    };
    const parsed = product
      ? updateProductSchema.safeParse(values)
      : createProductSchema.safeParse({ kind, ...values });
    const found: typeof errors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = String(issue.path[0]);
      if ((PRODUCT_FIELDS as readonly string[]).includes(field)) {
        const key =
          kind === 'amount' && (field === 'maxQuantity' || field === 'minQuantity')
            ? 'amountBounds'
            : (field as ProductField);
        found[field as ProductField] = t(`catalog.products.errors.${key}`);
      }
    }
    setErrors(found);
    if (!parsed.success) return focusInvalid();
    try {
      if (product) await update.mutateAsync({ id: product.id, body: parsed.data });
      else await create.mutateAsync(parsed.data as Parameters<typeof create.mutateAsync>[0]);
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NAME_TAKEN') {
        setErrors({ nameAr: catalogFailure(t, error) });
        focusInvalid();
      } else {
        setFailure(catalogFailure(t, error));
      }
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {product ? t('catalog.products.editTitle') : t('catalog.products.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('catalog.products.description')}</DialogDescription>
        {product && product.waitingAlerts > 0 && (
          <Badge tone="info">
            {t('catalog.products.waitingAlerts', { count: product.waitingAlerts })}
          </Badge>
        )}
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel render={<span />}>{t('catalog.products.kind')}</FieldLabel>
          <ToggleGroup<ProductKind>
            aria-label={t('catalog.products.kind')}
            value={[kind]}
            disabled={!!product}
            onValueChange={(value) => value[0] && changeKind(value[0])}
          >
            {PRODUCT_KINDS.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`catalog.products.kinds.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>
            {product ? t('catalog.products.kindFixed') : t(`catalog.products.kindHints.${kind}`)}
          </FieldDescription>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={!!errors.nameAr}>
            <FieldLabel>{t('catalog.products.name')}</FieldLabel>
            <Input name="nameAr" defaultValue={product?.nameAr} maxLength={60} autoComplete="off" />
            <FieldError match={!!errors.nameAr}>{errors.nameAr}</FieldError>
          </Field>
          <Field invalid={!!errors.gameAmount}>
            <FieldLabel>{t('catalog.products.amount')}</FieldLabel>
            <Input
              name="gameAmount"
              dir="ltr"
              inputMode="numeric"
              defaultValue={product?.gameAmount ?? ''}
              autoComplete="off"
            />
            <FieldDescription>{t('catalog.products.amountHint')}</FieldDescription>
            <FieldError match={!!errors.gameAmount}>{errors.gameAmount}</FieldError>
          </Field>
          <Field invalid={!!errors.officialPriceUsdUnits}>
            <FieldLabel>{t('catalog.products.official')}</FieldLabel>
            <Input
              name="officialPrice"
              dir="ltr"
              inputMode="decimal"
              defaultValue={
                product?.officialPriceUsdUnits ? dollars(product.officialPriceUsdUnits) : ''
              }
              autoComplete="off"
            />
            <FieldDescription>{t('catalog.products.officialHint')}</FieldDescription>
            <FieldError match={!!errors.officialPriceUsdUnits}>
              {errors.officialPriceUsdUnits}
            </FieldError>
          </Field>
          {kind !== 'amount' && (
            <Field invalid={!!errors.maxQuantity}>
              <FieldLabel>{t('catalog.products.maxQuantity')}</FieldLabel>
              <Input
                name="maxQuantity"
                dir="ltr"
                inputMode="numeric"
                value={maxQuantity}
                onChange={(event) => setMaxQuantity(event.target.value)}
                autoComplete="off"
              />
              <FieldDescription>{t('catalog.products.maxQuantityHint')}</FieldDescription>
              <FieldError match={!!errors.maxQuantity}>{errors.maxQuantity}</FieldError>
            </Field>
          )}
        </div>
        {kind === 'amount' && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field invalid={!!errors.amountUnitAr}>
              <FieldLabel>{t('catalog.products.amountUnit')}</FieldLabel>
              <Input
                name="amountUnitAr"
                defaultValue={product?.amountUnitAr ?? DEFAULT_AMOUNT_UNIT_AR}
                maxLength={16}
                autoComplete="off"
              />
              <FieldError match={!!errors.amountUnitAr}>{errors.amountUnitAr}</FieldError>
            </Field>
            <Field invalid={!!errors.minQuantity}>
              <FieldLabel>{t('catalog.products.minAmount')}</FieldLabel>
              <Input
                name="minAmount"
                dir="ltr"
                inputMode="numeric"
                value={minAmount}
                onChange={(event) => setMinAmount(event.target.value)}
                autoComplete="off"
              />
              <FieldError match={!!errors.minQuantity}>{errors.minQuantity}</FieldError>
            </Field>
            <Field invalid={!!errors.maxQuantity}>
              <FieldLabel>{t('catalog.products.maxAmount')}</FieldLabel>
              <Input
                name="maxAmount"
                dir="ltr"
                inputMode="numeric"
                value={maxAmount}
                onChange={(event) => setMaxAmount(event.target.value)}
                autoComplete="off"
              />
              <FieldError match={!!errors.maxQuantity}>{errors.maxQuantity}</FieldError>
            </Field>
            <p className="text-sm text-muted-foreground sm:col-span-3">
              {t('catalog.products.amountBoundsHint', {
                max: amountOfQuantity(MAX_AMOUNT_UNITS).toLocaleString('en-US'),
              })}
            </p>
          </div>
        )}
        {kind === 'code' && (
          <>
            <Field invalid={!!errors.regionAr}>
              <FieldLabel>{t('catalog.products.region')}</FieldLabel>
              <Input
                name="regionAr"
                defaultValue={product?.regionAr ?? ''}
                maxLength={64}
                autoComplete="off"
              />
              <FieldError match={!!errors.regionAr}>{errors.regionAr}</FieldError>
            </Field>
            <Field invalid={!!errors.redemptionAr}>
              <FieldLabel>{t('catalog.products.redemption')}</FieldLabel>
              <Textarea
                name="redemptionAr"
                defaultValue={product?.redemptionAr ?? ''}
                rows={4}
                maxLength={2000}
              />
              <FieldDescription>{t('catalog.products.redemptionHint')}</FieldDescription>
              <FieldError match={!!errors.redemptionAr}>{errors.redemptionAr}</FieldError>
            </Field>
          </>
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {product ? t('catalog.actions.save') : t('catalog.products.addSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
