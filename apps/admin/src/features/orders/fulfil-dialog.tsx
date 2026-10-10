import { useQuery } from '@tanstack/react-query';
import {
  type AdminOrder,
  CURRENCY_SCALE,
  type DeliveryProof,
  formatUsd,
  fulfilIsLoss,
  fulfilOrderSchema,
  parseUsd,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
  Checkbox,
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
} from '@vertex-digital/ui';
import { ImageIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
import { type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { rerouteOptionsQuery, useFulfilOrder, useUploadProof } from './orders.queries';

type FieldName = 'quantity' | 'codes' | 'cost' | 'acceptLoss' | 'proof' | 'reference' | 'reason';

const dollars = (units: number) => (units / CURRENCY_SCALE.USD).toFixed(2);

/** The units still to deliver: the order's quantity less what was delivered or refunded. */
export const remainingUnits = (order: AdminOrder) =>
  order.quantity - order.deliveredQuantity - order.refundedQuantity;

/**
 * S11 rules MF1–MF6: units delivered from another source. The cost starts at the product's manual
 * route's offer cost when one exists; the profit or loss shows as it is typed, and a loss needs a
 * ticked confirmation (MF4). The screenshot is uploaded at once (MF2) and previewed from the file
 * itself (the API serves a proof only once an attempt holds it); it stays on an error, as do the
 * other values. Re-authentication and the dialog's `Idempotency-Key`.
 */
export function FulfilDialog({ order, onDone }: { order: AdminOrder; onDone: () => void }) {
  const { t } = useTranslation();
  const units = remainingUnits(order);
  const codeProduct = order.product.kind === 'code';
  const options = useQuery(rerouteOptionsQuery(order.id));
  const manualCost = options.data?.routes.find(
    (route) => route.supplierCode === 'manual' && route.unitCostUsdUnits !== null,
  )?.unitCostUsdUnits;
  const fulfil = useFulfilOrder(order.id);
  const upload = useUploadProof(order.id);
  const keyFor = useIdempotencyKey();
  const fileInput = useRef<HTMLInputElement>(null);
  const lossId = useId();
  const [quantity, setQuantity] = useState(String(units));
  const [cost, setCost] = useState('');
  const [costTouched, setCostTouched] = useState(false);
  const [acceptLoss, setAcceptLoss] = useState(false);
  const [proof, setProof] = useState<DeliveryProof | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName, boolean>>>({});
  const [failure, setFailure] = useState<string | null>(null);

  // The manual offer's cost, once read, unless the admin already typed one.
  useEffect(() => {
    if (!costTouched && manualCost !== undefined && manualCost !== null) {
      setCost(dollars(manualCost));
    }
  }, [manualCost, costTouched]);

  const costUnits = parseUsd(cost);
  const count = Number(quantity.trim());
  const countValid = Number.isInteger(count) && count >= 1 && count <= units;
  const loss = costUnits !== null && fulfilIsLoss(costUnits, order.unitPriceUsdUnits);
  const profitUnits =
    costUnits !== null && countValid ? (order.unitPriceUsdUnits - costUnits) * count : null;

  async function choose(file: File | undefined) {
    if (!file) return;
    setUploadFailure(null);
    try {
      const stored = await upload.mutateAsync(file);
      const reader = new FileReader();
      reader.onload = () => setPreview(typeof reader.result === 'string' ? reader.result : null);
      reader.readAsDataURL(file);
      setProof(stored);
      setErrors((previous) => ({ ...previous, proof: false }));
    } catch (error) {
      setUploadFailure(errorMessage(t, error));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function drop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const reference = String(form.get('reference') ?? '').trim();
    const codes = String(form.get('codes') ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const body = {
      quantity: count,
      codes: codeProduct ? codes : [],
      unitCostUsdUnits: costUnits ?? Number.NaN,
      acceptLoss: loss && acceptLoss,
      proofFileId: proof?.fileId ?? '',
      reference: reference === '' ? undefined : reference,
      reason: String(form.get('reason') ?? ''),
    };
    const parsed = fulfilOrderSchema.safeParse(body);
    const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
    const next = {
      quantity: !countValid,
      codes: paths.has('codes') || (codeProduct && codes.length !== count),
      cost: paths.has('unitCostUsdUnits'),
      acceptLoss: loss && !acceptLoss,
      proof: proof === null,
      reference: paths.has('reference'),
      reason: paths.has('reason'),
    };
    setErrors(next);
    if (!parsed.success || Object.values(next).some(Boolean)) return;
    try {
      await fulfil.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
      if (error instanceof ApiError && error.code === 'PROOF_INVALID') {
        setProof(null);
        setPreview(null);
      }
    }
  }

  return (
    <DialogContent
      closeLabel={t('common.close')}
      className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>{t('orders.fulfil.title')}</DialogTitle>
        <DialogDescription>
          {t('orders.fulfil.description', { number: order.number })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.quantity}>
          <FieldLabel>{t('orders.fulfil.quantity')}</FieldLabel>
          <Input
            name="quantity"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <FieldDescription>{t('orders.fulfil.quantityHint', { units })}</FieldDescription>
          <FieldError match={!!errors.quantity}>
            {t('orders.decisions.delivered.quantityError', { units })}
          </FieldError>
        </Field>
        {codeProduct && (
          <Field invalid={!!errors.codes}>
            <FieldLabel>{t('orders.decisions.delivered.codes')}</FieldLabel>
            <Textarea name="codes" dir="ltr" rows={4} spellCheck={false} autoComplete="off" />
            <FieldDescription>{t('orders.decisions.delivered.codesHint')}</FieldDescription>
            <FieldError match={!!errors.codes}>
              {t('orders.decisions.delivered.codesError')}
            </FieldError>
          </Field>
        )}
        <Field invalid={!!errors.cost}>
          <FieldLabel>{t('orders.fulfil.cost')}</FieldLabel>
          <Input
            name="cost"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={cost}
            onChange={(event) => {
              setCostTouched(true);
              setCost(event.target.value);
            }}
          />
          <FieldDescription>
            {t('orders.fulfil.costHint', { price: ltr(formatUsd(order.unitPriceUsdUnits)) })}
          </FieldDescription>
          <FieldError match={!!errors.cost}>{t('orders.fulfil.costError')}</FieldError>
        </Field>
        {profitUnits !== null && (
          <p
            className={
              profitUnits < 0
                ? 'text-sm font-medium text-destructive-text'
                : 'text-sm font-medium text-status-success-foreground'
            }
            data-testid="fulfil-profit"
          >
            {profitUnits < 0
              ? t('orders.fulfil.loss', { amount: ltr(formatUsd(-profitUnits)) })
              : t('orders.fulfil.profit', { amount: ltr(formatUsd(profitUnits)) })}
          </p>
        )}
        {loss && (
          <div className="flex flex-col gap-1">
            <label
              htmlFor={lossId}
              className="flex cursor-pointer items-center gap-3 text-sm font-medium"
            >
              <Checkbox
                id={lossId}
                checked={acceptLoss}
                aria-invalid={errors.acceptLoss || undefined}
                onCheckedChange={(value) => setAcceptLoss(value)}
              />
              {t('orders.fulfil.acceptLoss')}
            </label>
            {errors.acceptLoss && (
              <p role="alert" className="text-sm text-destructive-text">
                {t('orders.fulfil.acceptLossError')}
              </p>
            )}
          </div>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('orders.fulfil.proof')}</legend>
          <button
            type="button"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            data-dragging={dragging || undefined}
            className="flex min-h-40 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted p-2 transition-colors duration-150 ease-out hover:border-primary data-dragging:border-primary"
          >
            {preview ? (
              <img
                src={preview}
                alt={t('orders.fulfil.proofAlt')}
                className="max-h-64 object-contain"
              />
            ) : (
              <span className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <ImageIcon className="size-8" aria-hidden="true" />
                {t('orders.fulfil.proofDrop')}
              </span>
            )}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            aria-label={t('orders.fulfil.proof')}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <UploadIcon />
              {upload.isPending
                ? t('orders.fulfil.proofUploading')
                : proof
                  ? t('orders.fulfil.proofReplace')
                  : t('orders.fulfil.proofPick')}
            </Button>
          </div>
          {(uploadFailure || errors.proof) && (
            <p role="alert" className="text-sm text-destructive-text">
              {uploadFailure ?? t('orders.fulfil.proofError')}
            </p>
          )}
        </fieldset>
        <Field invalid={!!errors.reference}>
          <FieldLabel>{t('orders.fulfil.reference')}</FieldLabel>
          <Input name="reference" dir="ltr" autoComplete="off" maxLength={200} />
          <FieldDescription>{t('orders.fulfil.referenceHint')}</FieldDescription>
          <FieldError match={!!errors.reference}>{t('orders.fulfil.referenceError')}</FieldError>
        </Field>
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('orders.decisions.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={!!errors.reason}>{t('orders.decisions.reasonError')}</FieldError>
        </Field>
        {order.status === 'needs_review' && (
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('orders.reroute.warning')}
          />
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={fulfil.isPending || upload.isPending}>
            {fulfil.isPending ? t('orders.decisions.submitting') : t('orders.fulfil.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
