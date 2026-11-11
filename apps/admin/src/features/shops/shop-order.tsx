import { Link } from '@tanstack/react-router';
import {
  type AdminOrder,
  formatUsd,
  SHOP_COMPENSATION_MARGIN_SOURCES,
  type ShopCompensationMarginSource,
  shopCompensationAmounts,
  shopCompensationRefusal,
  shopCompensationRequestSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
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
  useFocusInvalid,
} from '@vertex-digital/ui';
import { HandCoinsIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { useIdempotentRequest } from '../../lib/idempotency';
import { Picker } from '../pricing/picker';
import { useCompensateShopOrder } from './shops.queries';

type ShopSale = NonNullable<AdminOrder['shopSale']>;

const usd = (units: number) => (
  <bdi dir="ltr" className="tabular-nums">
    {formatUsd(units)}
  </bdi>
);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** The units of a shop order still open to a compensation now (PR10), 0 when none. */
export function compensableUnits(order: AdminOrder, sale: ShopSale, now = new Date()): number {
  const facts = {
    shopOrder: true,
    finishedAt: order.finishedAt ? new Date(order.finishedAt) : null,
    deliveredQuantity: order.deliveredQuantity,
    compensatedQuantity: sale.compensatedQuantity,
  };
  if (shopCompensationRefusal(facts, 1, now) !== null) return 0;
  return order.deliveredQuantity - sale.compensatedQuantity;
}

/**
 * S26 Screens, PR10: a shop order's line on its page: the shop, its customer (the buyer; the
 * order's customer is the merchant), the selling price, the margin released or held, the units
 * compensated, and «تعويض زبون المتجر» while the 7-day window allows one.
 */
export function ShopOrderCard({ order, sale }: { order: AdminOrder; sale: ShopSale }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const units = compensableUnits(order, sale);
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-lg">{t('shops.order.title')}</CardTitle>
        {units > 0 && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <HandCoinsIcon />
            {t('shops.order.compensate')}
          </Button>
        )}
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Fact label={t('shops.order.shop')}>
          <Link
            to="/shops/$id"
            params={{ id: sale.shop.id }}
            className="rounded-sm underline-offset-4 hover:underline"
          >
            {sale.shop.displayName}
          </Link>
        </Fact>
        <Fact label={t('shops.order.customer')}>{sale.shopCustomer.name}</Fact>
        <Fact label={t('shops.order.unitSell')}>{usd(sale.unitSellUsdUnits)}</Fact>
        <Fact label={t('shops.order.totalSell')}>{usd(sale.totalSellUsdUnits)}</Fact>
        <Fact label={t('shops.order.margin')}>
          {sale.marginReleasedUsdUnits === null ? (
            <Badge tone="warning">{t('shops.marginStates.held')}</Badge>
          ) : (
            <span className="flex items-center gap-2">
              {usd(sale.marginReleasedUsdUnits)}
              <Badge tone="success">{t('shops.marginStates.released')}</Badge>
            </span>
          )}
        </Fact>
        <Fact label={t('shops.order.compensated')}>{sale.compensatedQuantity}</Fact>
      </dl>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <CompensationDialog
            order={order}
            sale={sale}
            units={units}
            onDone={() => setOpen(false)}
          />
        )}
      </Dialog>
    </Card>
  );
}

type Errors = Partial<Record<'units' | 'reason' | 'marginFrom', boolean>>;

/**
 * PR10: compensates delivered units of a shop order: Vertex's part (the merchant's price) and,
 * when the margin was released, the margin from the merchant's wallet, the store or nobody (the
 * shop ticket tells the merchant what is owed); re-authenticated, with the dialog's
 * `Idempotency-Key`. A merchant balance that does not cover the margin is refused under its field.
 */
function CompensationDialog({
  order,
  sale,
  units,
  onDone,
}: {
  order: AdminOrder;
  sale: ShopSale;
  units: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const compensate = useCompensateShopOrder(order.id);
  const send = useIdempotentRequest();
  const [count, setCount] = useState(String(units));
  const [marginFrom, setMarginFrom] = useState<ShopCompensationMarginSource>('merchant');
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const released = (sale.marginReleasedUsdUnits ?? 0) > 0;
  const n = /^\d{1,6}$/.test(count.trim()) ? Number(count.trim()) : 0;
  const amounts =
    n > 0 && n <= units
      ? shopCompensationAmounts(sale.unitSellUsdUnits, order.unitPriceUsdUnits, n, released)
      : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const body = {
      units: n,
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
      marginFrom: released ? marginFrom : ('none' as const),
    };
    const parsed = shopCompensationRequestSchema.safeParse(body);
    const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
    const next = { units: paths.has('units') || n < 1 || n > units, reason: paths.has('reason') };
    setErrors(next);
    if (!parsed.success || next.units) return focusInvalid();
    try {
      await send(parsed.data, (key) => compensate.mutateAsync({ body: parsed.data, key }));
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INSUFFICIENT_BALANCE') {
        setErrors({ marginFrom: true });
        focusInvalid();
        return;
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('shops.compensation.title', { number: order.number })}</DialogTitle>
        <DialogDescription>
          {t('shops.compensation.description', { name: sale.shopCustomer.name })}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.units}>
          <FieldLabel>{t('shops.compensation.units')}</FieldLabel>
          <Input
            name="units"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
          <FieldDescription>{t('shops.compensation.unitsHint', { units })}</FieldDescription>
          <FieldError match={!!errors.units}>
            {t('shops.compensation.unitsError', { units })}
          </FieldError>
        </Field>
        {released && (
          <Field invalid={!!errors.marginFrom}>
            <FieldLabel render={<span />}>{t('shops.compensation.marginFrom')}</FieldLabel>
            <Picker
              label={t('shops.compensation.marginFrom')}
              items={SHOP_COMPENSATION_MARGIN_SOURCES.map((value) => ({
                value,
                label: t(`shops.compensation.sources.${value}`),
              }))}
              value={marginFrom}
              onChange={(value) => setMarginFrom(value as ShopCompensationMarginSource)}
            />
            <FieldDescription>{t(`shops.compensation.hints.${marginFrom}`)}</FieldDescription>
            <FieldError match={!!errors.marginFrom}>
              {t('shops.compensation.merchantShort')}
            </FieldError>
          </Field>
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('shops.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={!!errors.reason}>{t('shops.fields.reasonError')}</FieldError>
        </Field>
        {amounts && (
          <p className="text-base font-medium">
            {released && marginFrom !== 'none'
              ? t('shops.compensation.summaryBoth', {
                  vertex: ltr(formatUsd(amounts.vertexUsdUnits)),
                  margin: ltr(formatUsd(amounts.marginUsdUnits)),
                })
              : t('shops.compensation.summaryVertex', {
                  vertex: ltr(formatUsd(amounts.vertexUsdUnits)),
                })}
          </p>
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={compensate.isPending}>
            {compensate.isPending ? t('shops.submitting') : t('shops.compensation.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
