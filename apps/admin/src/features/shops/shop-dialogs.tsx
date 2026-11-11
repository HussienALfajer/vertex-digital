import {
  type AdminShop,
  approveShopSchema,
  formatUsd,
  parseUsd,
  SHOP_DEFAULT_LIMITS,
  SHOP_SETTLEMENT_TARGETS,
  SHOP_SUSPEND_REASONS,
  type ShopLimits,
  type ShopSettlementTarget,
  type ShopSuspendReason,
  settleShopCustomerSchema,
  shopReasonSchema,
  suspendShopSchema,
  updateShopSchema,
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
  useFocusInvalid,
} from '@vertex-digital/ui';
import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { useIdempotentRequest } from '../../lib/idempotency';
import { Picker } from '../pricing/picker';
import {
  useApproveShop,
  useCloseShop,
  useRejectShop,
  useSettleShopCustomer,
  useShopCustomerFreeze,
  useSuspendShop,
  useUpdateShop,
} from './shops.queries';

/** Dollars as the limit fields show them: no sign and no grouping, so `parseUsd` reads them back. */
const dollars = (units: number) => formatUsd(units).replace(/[$,]/g, '');

type LimitField = 'customerBalanceCapUsdUnits' | 'dailyTransferCapUsdUnits' | 'customerLimit';

/** SH8: the three limits read from a form; null fields are refused by the schema. */
function limitsOf(form: FormData): Record<LimitField, number | null> {
  const count = String(form.get('customerLimit') ?? '').trim();
  return {
    customerBalanceCapUsdUnits: parseUsd(String(form.get('customerBalanceCapUsdUnits') ?? '')),
    dailyTransferCapUsdUnits: parseUsd(String(form.get('dailyTransferCapUsdUnits') ?? '')),
    customerLimit: /^\d{1,6}$/.test(count) ? Number(count) : null,
  };
}

function LimitFields({ limits, invalid }: { limits: ShopLimits; invalid: Set<string> }) {
  const { t } = useTranslation();
  return (
    <>
      <Field invalid={invalid.has('customerBalanceCapUsdUnits')}>
        <FieldLabel>{t('shops.limits.balanceCap')}</FieldLabel>
        <Input
          name="customerBalanceCapUsdUnits"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={dollars(limits.customerBalanceCapUsdUnits)}
        />
        <FieldDescription>{t('shops.limits.balanceCapHint')}</FieldDescription>
        <FieldError match={invalid.has('customerBalanceCapUsdUnits')}>
          {t('shops.limits.balanceCapError')}
        </FieldError>
      </Field>
      <Field invalid={invalid.has('dailyTransferCapUsdUnits')}>
        <FieldLabel>{t('shops.limits.dailyCap')}</FieldLabel>
        <Input
          name="dailyTransferCapUsdUnits"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={dollars(limits.dailyTransferCapUsdUnits)}
        />
        <FieldDescription>{t('shops.limits.dailyCapHint')}</FieldDescription>
        <FieldError match={invalid.has('dailyTransferCapUsdUnits')}>
          {t('shops.limits.dailyCapError')}
        </FieldError>
      </Field>
      <Field invalid={invalid.has('customerLimit')}>
        <FieldLabel>{t('shops.limits.customerLimit')}</FieldLabel>
        <Input
          name="customerLimit"
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={String(limits.customerLimit)}
        />
        <FieldError match={invalid.has('customerLimit')}>
          {t('shops.limits.customerLimitError')}
        </FieldError>
      </Field>
    </>
  );
}

/** The fields a refusal names: the first part of each issue's path, or the field under it. */
function issueFields(issues: readonly { path: readonly PropertyKey[] }[]): Set<string> {
  return new Set(
    issues.map((issue) =>
      String(issue.path[0] === 'limits' ? (issue.path[1] ?? 'limits') : issue.path[0]),
    ),
  );
}

/** A slug refused by the API (`SLUG_TAKEN`) shows under its field. */
const slugTaken = (error: unknown) => error instanceof ApiError && error.code === 'SLUG_TAKEN';

/** SH3, SH8: approves a request: the slug as proposed or edited, and the shop's limits. */
export function ApproveShopDialog({ shop, onDone }: { shop: AdminShop; onDone: () => void }) {
  const { t } = useTranslation();
  const approve = useApproveShop(shop.id);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const slug = String(form.get('slug') ?? '').trim();
    const body = {
      ...(slug !== shop.slug && { slug }),
      limits: limitsOf(form),
    };
    const parsed = approveShopSchema.safeParse(body);
    if (!parsed.success) {
      setInvalid(issueFields(parsed.error.issues));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await approve.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      if (slugTaken(error)) {
        setInvalid(new Set(['slug']));
        focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('shops.approve.title', { name: shop.displayName })}</DialogTitle>
        <DialogDescription>{t('shops.approve.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('slug')}>
          <FieldLabel>{t('shops.fields.slug')}</FieldLabel>
          <Input name="slug" dir="ltr" autoComplete="off" maxLength={30} defaultValue={shop.slug} />
          <FieldDescription>{t('shops.fields.slugHint')}</FieldDescription>
          <FieldError match={invalid.has('slug')}>{t('shops.fields.slugError')}</FieldError>
        </Field>
        <LimitFields limits={{ ...SHOP_DEFAULT_LIMITS }} invalid={invalid} />
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={invalid.size > 0} />
        <DialogFooter>
          <Button type="submit" disabled={approve.isPending}>
            {approve.isPending ? t('shops.submitting') : t('shops.approve.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * A decision that only needs a reason: a rejection (the merchant reads it, SH1), a close (SH7,
 * re-authenticated), a customer's freeze or unfreeze (CA7; the merchant never sees the reason).
 */
export function ReasonDialog({
  kind,
  shop,
  customer,
  onDone,
}: {
  kind: 'reject' | 'close' | 'freeze' | 'unfreeze';
  shop: AdminShop;
  customer?: { id: string; name: string };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reject = useRejectShop(shop.id);
  const close = useCloseShop(shop.id);
  const freeze = useShopCustomerFreeze(customer?.id ?? '');
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const pending = reject.isPending || close.isPending || freeze.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = shopReasonSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    try {
      if (kind === 'reject') await reject.mutateAsync(parsed.data.reason);
      else if (kind === 'close') await close.mutateAsync(parsed.data.reason);
      else await freeze.mutateAsync({ frozen: kind === 'freeze', reason: parsed.data.reason });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const name = customer?.name ?? shop.displayName;
  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t(`shops.${kind}.title`, { name })}</DialogTitle>
        <DialogDescription>{t(`shops.${kind}.description`)}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {kind === 'close' && shop.totalBalanceUsdUnits > 0 && (
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('shops.close.balances', {
              amount: ltr(formatUsd(shop.totalBalanceUsdUnits)),
            })}
          />
        )}
        <Field invalid={invalid}>
          <FieldLabel>{t('shops.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('shops.fields.reasonError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button
            type="submit"
            variant={
              kind === 'reject' || kind === 'close' || kind === 'freeze' ? 'destructive' : 'primary'
            }
            disabled={pending}
          >
            {pending ? t('shops.submitting') : t(`shops.${kind}.submit`)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** SH6: the category the shop shows («المتجر متوقف مؤقتاً») and the admin's own note. */
export function SuspendShopDialog({ shop, onDone }: { shop: AdminShop; onDone: () => void }) {
  const { t } = useTranslation();
  const suspend = useSuspendShop(shop.id);
  const [reason, setReason] = useState<ShopSuspendReason | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = suspendShopSchema.safeParse({
      reason,
      note: String(new FormData(event.currentTarget).get('note') ?? ''),
    });
    if (!parsed.success) {
      setInvalid(issueFields(parsed.error.issues));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await suspend.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('shops.suspend.title', { name: shop.displayName })}</DialogTitle>
        <DialogDescription>{t('shops.suspend.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('reason')}>
          <FieldLabel render={<span />}>{t('shops.suspend.reason')}</FieldLabel>
          <Picker
            label={t('shops.suspend.reason')}
            placeholder={t('shops.fields.choose')}
            items={SHOP_SUSPEND_REASONS.map((value) => ({
              value,
              label: t(`shops.suspendReasons.${value}`),
            }))}
            value={reason}
            onChange={(value) => setReason(value as ShopSuspendReason)}
          />
          <FieldDescription>{t('shops.suspend.reasonHint')}</FieldDescription>
          <FieldError match={invalid.has('reason')}>{t('shops.suspend.reasonError')}</FieldError>
        </Field>
        <Field invalid={invalid.has('note')}>
          <FieldLabel>{t('shops.suspend.note')}</FieldLabel>
          <Textarea name="note" rows={3} maxLength={500} />
          <FieldDescription>{t('shops.suspend.noteHint')}</FieldDescription>
          <FieldError match={invalid.has('note')}>{t('shops.fields.reasonError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={invalid.size > 0} />
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={suspend.isPending}>
            {suspend.isPending ? t('shops.submitting') : t('shops.suspend.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * SH3, SH8, ST5: the limits, the slug (the old one keeps redirecting) and clearing the
 * announcement, with a reason; re-authenticated. Only what changed is sent.
 */
export function EditShopDialog({ shop, onDone }: { shop: AdminShop; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateShop(shop.id);
  const [clear, setClear] = useState(false);
  const clearId = useId();
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const slug = String(form.get('slug') ?? '').trim();
    const limits = limitsOf(form);
    const limitsChanged = (Object.keys(limits) as LimitField[]).some(
      (key) => limits[key] !== shop.limits[key],
    );
    const body = {
      ...(limitsChanged && { limits }),
      ...(slug !== shop.slug && { slug }),
      ...(clear && { clearAnnouncement: true as const }),
      reason: String(form.get('reason') ?? ''),
    };
    const parsed = updateShopSchema.safeParse(body);
    if (!parsed.success) {
      const fields = issueFields(parsed.error.issues);
      // "Nothing to update": the refine's issue has no path.
      setInvalid(fields.has('undefined') ? new Set(['nothing']) : fields);
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await update.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      if (slugTaken(error)) {
        setInvalid(new Set(['slug']));
        focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('shops.edit.title', { name: shop.displayName })}</DialogTitle>
        <DialogDescription>{t('shops.edit.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('slug')}>
          <FieldLabel>{t('shops.fields.slug')}</FieldLabel>
          <Input name="slug" dir="ltr" autoComplete="off" maxLength={30} defaultValue={shop.slug} />
          <FieldDescription>{t('shops.edit.slugHint')}</FieldDescription>
          <FieldError match={invalid.has('slug')}>{t('shops.fields.slugError')}</FieldError>
        </Field>
        <LimitFields limits={shop.limits} invalid={invalid} />
        {shop.announcement && (
          <Field>
            <label htmlFor={clearId} className="flex cursor-pointer items-start gap-3 text-sm">
              <Checkbox id={clearId} checked={clear} onCheckedChange={(value) => setClear(value)} />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{t('shops.edit.clearAnnouncement')}</span>
                <span className="break-words text-muted-foreground">{shop.announcement}</span>
              </span>
            </label>
          </Field>
        )}
        <Field invalid={invalid.has('reason')}>
          <FieldLabel>{t('shops.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid.has('reason')}>{t('shops.fields.reasonError')}</FieldError>
        </Field>
        {invalid.has('nothing') && <FormAlert>{t('shops.edit.nothing')}</FormAlert>}
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={invalid.size > 0 && !invalid.has('nothing')} />
        <DialogFooter>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? t('shops.submitting') : t('shops.edit.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * WL9: a closed shop customer's whole balance, back to the merchant's wallet (the merchant pays
 * the customer cash) or as the store's cash refund; a reason, re-authentication and the dialog's
 * `Idempotency-Key`, kept across retries.
 */
export function SettleDialog({
  shop,
  customer,
  onDone,
}: {
  shop: AdminShop;
  customer: { id: string; name: string; balanceUsdUnits: number };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const settle = useSettleShopCustomer(shop.id, customer.id);
  const send = useIdempotentRequest();
  const [to, setTo] = useState<ShopSettlementTarget | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const amount = ltr(formatUsd(customer.balanceUsdUnits));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = settleShopCustomerSchema.safeParse({
      to,
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    if (!parsed.success) {
      setInvalid(issueFields(parsed.error.issues));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await send(parsed.data, (key) => settle.mutateAsync({ body: parsed.data, key }));
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('shops.settle.title', { name: customer.name })}</DialogTitle>
        <DialogDescription>{t('shops.settle.description', { amount })}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('to')}>
          <FieldLabel render={<span />}>{t('shops.settle.to')}</FieldLabel>
          <Picker
            label={t('shops.settle.to')}
            placeholder={t('shops.fields.choose')}
            items={SHOP_SETTLEMENT_TARGETS.map((value) => ({
              value,
              label: t(`shops.settle.targets.${value}`),
            }))}
            value={to}
            onChange={(value) => setTo(value as ShopSettlementTarget)}
          />
          {to && <FieldDescription>{t(`shops.settle.hints.${to}`)}</FieldDescription>}
          <FieldError match={invalid.has('to')}>{t('shops.settle.toError')}</FieldError>
        </Field>
        <Field invalid={invalid.has('reason')}>
          <FieldLabel>{t('shops.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid.has('reason')}>{t('shops.fields.reasonError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={invalid.size > 0} />
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={settle.isPending}>
            {settle.isPending ? t('shops.submitting') : t('shops.settle.submit', { amount })}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
