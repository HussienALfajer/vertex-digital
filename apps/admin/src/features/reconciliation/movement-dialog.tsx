import {
  type CreateTreasuryMovement,
  ceilToStep,
  createTreasuryMovementSchema,
  formatRate,
  impliedRate,
  isOutsidePlace,
  type MoneyPlaces,
  OUTSIDE_CATEGORIES,
  type OutsideCategory,
  TREASURY_PLACES,
  type TreasuryPlace,
  treasuryMovementError,
  USD_CENT,
} from '@vertex-digital/contracts';
import {
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { useIdempotentRequest } from '../../lib/idempotency';
import { ConfirmAmountField } from '../wallet/adjustment-form';
import { useCreateMovement } from './reconciliation.queries';
import { money, placeLabel } from './reconciliation-labels';
import {
  parsePlaceAmount,
  placeAmountText,
  placeCurrency,
  type TreasuryField,
  type TreasuryFieldErrors,
  treasuryFailure,
  useNeedsConfirmation,
} from './treasury-form';

type Place = MoneyPlaces['places'][number];

const FIELDS: readonly TreasuryField[] = [
  'from',
  'to',
  'sent',
  'received',
  'category',
  'opening',
  'reference',
  'reason',
  'confirm',
];

/** The contract's field of a schema issue, as the dialog names its fields. */
const FIELD_OF_PATH: Record<string, TreasuryField> = {
  from: 'from',
  to: 'to',
  sentUnits: 'sent',
  receivedUnits: 'received',
  outsideCategory: 'category',
  openingBalance: 'opening',
  externalReference: 'reference',
  reason: 'reason',
};

/** The outside place in a currency. */
const outsideOf = (place: TreasuryPlace): TreasuryPlace =>
  placeCurrency(place) === 'SYP' ? 'outside_syp' : 'outside_usd';

/** The amounts an opening proposes (rule T6): sent in whole cents from outside, received exact. */
function openingAmounts(place: Place): { sent: string; received: string } {
  const proposed = place.proposedOpeningUnits;
  if (proposed === null) return { sent: '', received: '' };
  const from = outsideOf(place.place);
  const sent = placeCurrency(place.place) === 'USD' ? ceilToStep(proposed, USD_CENT) : proposed;
  return {
    sent: placeAmountText(from, sent),
    received: placeAmountText(place.place, proposed),
  };
}

/**
 * "تسجيل حركة" (rules T2–T8): from, to, the amount sent and the amount received (the same until
 * edited, in one currency), the category when one side is outside, the opening switch with the
 * proposed amount, reference and reason; above $100 the amount typed twice. Opened from a place
 * without an opening, it proposes one from outside; otherwise money leaves that place.
 */
export function MovementDialog({
  places,
  place,
  onDone,
}: {
  places: Place[];
  /** The row the dialog was opened from. */
  place: Place | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateMovement();
  const send = useIdempotentRequest();
  // Rule T6: a place without an opening proposes one; the outside takes none.
  const opening = place !== null && !place.openingRecorded && !isOutsidePlace(place.place);
  const initial = place && opening ? openingAmounts(place) : { sent: '', received: '' };
  const [from, setFrom] = useState<TreasuryPlace | null>(
    place ? (opening ? outsideOf(place.place) : place.place) : null,
  );
  const [to, setTo] = useState<TreasuryPlace | null>(opening && place ? place.place : null);
  const [sentText, setSentText] = useState(initial.sent);
  const [receivedText, setReceivedText] = useState(initial.received);
  // Received follows sent until the admin types it (one currency, no fee).
  const [receivedEdited, setReceivedEdited] = useState(opening);
  const [category, setCategory] = useState<OutsideCategory | null>(opening ? 'owner' : null);
  const [openingBalance, setOpeningBalance] = useState(opening);
  const [confirmText, setConfirmText] = useState('');
  const [forceConfirm, setForceConfirm] = useState(false);
  const [errors, setErrors] = useState<TreasuryFieldErrors>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);

  const sameCurrency = from && to ? placeCurrency(from) === placeCurrency(to) : true;
  const outside = (from && isOutsidePlace(from)) || (to && isOutsidePlace(to));
  const sentUnits = from ? parsePlaceAmount(from, sentText) : null;
  const shownReceived = receivedEdited || !sameCurrency ? receivedText : sentText;
  const receivedUnits = to ? parsePlaceAmount(to, shownReceived) : null;
  const needsConfirmation =
    useNeedsConfirmation(from ? placeCurrency(from) : 'USD', sentUnits) || forceConfirm;
  const destination = places.find((item) => item.place === to) ?? null;
  const canOpen = !!from && isOutsidePlace(from) && category === 'owner';

  function changeFrom(next: TreasuryPlace | null) {
    setFrom(next);
    if (next && !isOutsidePlace(next) && !(to && isOutsidePlace(to))) setCategory(null);
    if (!next || !isOutsidePlace(next)) setOpeningBalance(false);
  }

  function changeTo(next: TreasuryPlace | null) {
    // An opening belongs to the place it was proposed for (rule T6): a new destination clears it.
    if (next !== to) setOpeningBalance(false);
    setTo(next);
    if (next && !isOutsidePlace(next) && !(from && isOutsidePlace(from))) setCategory(null);
  }

  function changeOpening(next: boolean) {
    setOpeningBalance(next);
    if (next && destination) {
      const amounts = openingAmounts(destination);
      if (amounts.sent) {
        setSentText(amounts.sent);
        setReceivedText(amounts.received);
        setReceivedEdited(true);
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const body = {
      from: from ?? undefined,
      to: to ?? undefined,
      sentUnits: sentUnits ?? Number.NaN,
      receivedUnits: receivedUnits ?? Number.NaN,
      outsideCategory: outside ? (category ?? undefined) : undefined,
      openingBalance: canOpen && openingBalance,
      externalReference: text('externalReference') || undefined,
      reason: text('reason'),
      amountConfirmationUnits:
        needsConfirmation && from ? (parsePlaceAmount(from, confirmText) ?? -1) : undefined,
    };
    const parsed = createTreasuryMovementSchema.safeParse(body);
    const found: TreasuryFieldErrors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = FIELD_OF_PATH[String(issue.path[0])];
      if (field && !found[field]) found[field] = t(`reconciliation.movement.errors.${field}`);
    }
    if (parsed.success) {
      const refused = treasuryMovementError(parsed.data);
      if (refused) {
        const field = refused === 'TREASURY_PLACES_INVALID' ? 'to' : 'received';
        found[field] = t(`errors.api.${refused}`);
      }
    }
    if (needsConfirmation && body.amountConfirmationUnits !== sentUnits) {
      found.confirm = t('wallets.adjust.errors.confirm');
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return focusInvalid();

    const request: CreateTreasuryMovement = parsed.data;
    try {
      await send(request, (key) => create.mutateAsync({ body: request, key }));
      onDone();
    } catch (error) {
      const shown = treasuryFailure(t, error, FIELDS);
      if (shown.field === 'confirm') setForceConfirm(true);
      if (!shown.field) return setFailure(shown.message);
      setErrors({ [shown.field]: shown.message });
      focusInvalid();
    }
  }

  const placeItems = TREASURY_PLACES.map((item) => ({ value: item, label: placeLabel(t, item) }));
  const fee =
    sameCurrency && sentUnits !== null && receivedUnits !== null && from
      ? sentUnits - receivedUnits
      : null;
  const rate =
    !sameCurrency && sentUnits !== null && receivedUnits !== null && from
      ? placeCurrency(from) === 'SYP'
        ? impliedRate(sentUnits, receivedUnits)
        : impliedRate(receivedUnits, sentUnits)
      : null;

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('reconciliation.movement.title')}</DialogTitle>
        <DialogDescription>{t('reconciliation.movement.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <PlaceSelect
            label={t('reconciliation.movement.from')}
            value={from}
            onChange={changeFrom}
            items={placeItems}
            error={errors.from}
          />
          <PlaceSelect
            label={t('reconciliation.movement.to')}
            value={to}
            onChange={changeTo}
            items={placeItems}
            error={errors.to}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={!!errors.sent}>
            <FieldLabel>
              {t('reconciliation.movement.sent', {
                currency: t(`reconciliation.currencies.${from ? placeCurrency(from) : 'USD'}`),
              })}
            </FieldLabel>
            <Input
              name="sent"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={sentText}
              onChange={(event) => setSentText(event.target.value)}
            />
            <FieldError match={!!errors.sent}>{errors.sent}</FieldError>
          </Field>
          <Field invalid={!!errors.received}>
            <FieldLabel>
              {t('reconciliation.movement.received', {
                currency: t(`reconciliation.currencies.${to ? placeCurrency(to) : 'USD'}`),
              })}
            </FieldLabel>
            <Input
              name="received"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={shownReceived}
              onChange={(event) => {
                setReceivedEdited(true);
                setReceivedText(event.target.value);
              }}
            />
            <FieldDescription>
              {fee !== null && from && fee > 0
                ? t('reconciliation.movement.fee', { fee: money(t, placeCurrency(from), fee) })
                : rate !== null
                  ? t('reconciliation.movement.rate', { rate: formatRate(rate) })
                  : t('reconciliation.movement.receivedHint')}
            </FieldDescription>
            <FieldError match={!!errors.received}>{errors.received}</FieldError>
          </Field>
        </div>
        {needsConfirmation && (
          <ConfirmAmountField
            value={confirmText}
            onChange={setConfirmText}
            error={errors.confirm}
          />
        )}
        {outside && (
          <Field invalid={!!errors.category}>
            <FieldLabel>{t('reconciliation.movement.category')}</FieldLabel>
            <Select
              items={OUTSIDE_CATEGORIES.map((item) => ({
                value: item,
                label: t(`reconciliation.categories.${item}`),
              }))}
              value={category}
              onValueChange={(value) => {
                setCategory(value);
                if (value !== 'owner') setOpeningBalance(false);
              }}
            >
              <SelectTrigger aria-label={t('reconciliation.movement.category')}>
                <SelectValue placeholder={t('reconciliation.movement.chooseCategory')} />
              </SelectTrigger>
              <SelectContent>
                {OUTSIDE_CATEGORIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`reconciliation.categories.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError match={!!errors.category}>{errors.category}</FieldError>
          </Field>
        )}
        {canOpen && (
          <Field invalid={!!errors.opening}>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel>{t('reconciliation.movement.opening')}</FieldLabel>
              <Switch
                checked={openingBalance}
                onCheckedChange={changeOpening}
                aria-label={t('reconciliation.movement.opening')}
              />
            </div>
            <FieldDescription>
              {destination?.proposedOpeningUnits != null
                ? t('reconciliation.movement.openingProposed', {
                    amount: money(t, destination.currency, destination.proposedOpeningUnits),
                  })
                : t('reconciliation.movement.openingHint')}
            </FieldDescription>
            <FieldError match={!!errors.opening}>{errors.opening}</FieldError>
          </Field>
        )}
        <Field invalid={!!errors.reference}>
          <FieldLabel>{t('reconciliation.movement.reference')}</FieldLabel>
          <Input
            name="externalReference"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
          <FieldError match={!!errors.reference}>{errors.reference}</FieldError>
        </Field>
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('reconciliation.movement.reason')}</FieldLabel>
          <Textarea name="reason" rows={2} maxLength={500} />
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('reconciliation.saving') : t('reconciliation.movement.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function PlaceSelect({
  label,
  value,
  onChange,
  items,
  error,
}: {
  label: string;
  value: TreasuryPlace | null;
  onChange: (value: TreasuryPlace | null) => void;
  items: { value: TreasuryPlace; label: string }[];
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field invalid={!!error}>
      <FieldLabel>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => onChange(next)}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={t('reconciliation.movement.choosePlace')} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}
