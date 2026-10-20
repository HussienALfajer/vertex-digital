import { useQuery } from '@tanstack/react-query';
import {
  GOVERNORATES,
  type Governorate,
  grantMerchantSchema,
  ROOT_PRICE_LIST_IDS,
  revokeMerchantSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { Picker } from '../pricing/picker';
import { priceListsQuery } from '../pricing/pricing.queries';
import { useGrantMerchant, useRevokeMerchant } from './merchants.queries';

/** The lists a merchant may pay: unarchived and priced; wholesale is the default. */
export function useListItems() {
  const lists = useQuery(priceListsQuery);
  return (lists.data ?? [])
    .filter((list) => list.archivedAt === null && list.ready)
    .map((list) => ({ value: list.id, label: list.name }));
}

type GrantField = 'tradeName' | 'governorate' | 'city' | 'reason';

/**
 * MA6, decision 10: makes a customer a merchant from the panel: trade name, governorate, city, an
 * optional list (wholesale by default) and a reason; re-authenticated. The merchant then accepts
 * the merchant terms before the first purchase.
 */
export function GrantMerchantDialog({
  customer,
  onDone,
}: {
  customer: { id: string; name: string };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const grant = useGrantMerchant(customer.id);
  const items = useListItems();
  const [governorate, setGovernorate] = useState<Governorate | null>(null);
  const [listId, setListId] = useState<string>(ROOT_PRICE_LIST_IDS.wholesale);
  const [invalid, setInvalid] = useState<Set<GrantField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const parsed = grantMerchantSchema.safeParse({
      tradeName: String(form.get('tradeName') ?? ''),
      governorate,
      city: String(form.get('city') ?? ''),
      priceListId: listId,
      reason: String(form.get('reason') ?? ''),
    });
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => issue.path[0] as GrantField)));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await grant.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const governorates = GOVERNORATES.map((value) => ({
    value,
    label: t(`merchants.governorates.${value}`),
  }));
  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.grant.title', { name: customer.name })}</DialogTitle>
        <DialogDescription>{t('merchants.grant.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('tradeName')}>
          <FieldLabel>{t('merchants.fields.tradeName')}</FieldLabel>
          <Input name="tradeName" maxLength={80} autoComplete="off" />
          <FieldError match={invalid.has('tradeName')}>
            {t('merchants.validation.tradeName')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('governorate')}>
          <FieldLabel render={<span />}>{t('merchants.fields.governorate')}</FieldLabel>
          <Picker
            label={t('merchants.fields.governorate')}
            placeholder={t('merchants.fields.choose')}
            items={governorates}
            value={governorate}
            onChange={(value) => setGovernorate(value as Governorate)}
          />
          <FieldError match={invalid.has('governorate')}>
            {t('merchants.validation.governorate')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('city')}>
          <FieldLabel>{t('merchants.fields.city')}</FieldLabel>
          <Input name="city" maxLength={60} autoComplete="off" />
          <FieldError match={invalid.has('city')}>{t('merchants.validation.city')}</FieldError>
        </Field>
        <Field>
          <FieldLabel render={<span />}>{t('merchants.fields.priceList')}</FieldLabel>
          <Picker
            label={t('merchants.fields.priceList')}
            items={items}
            value={listId}
            onChange={setListId}
          />
        </Field>
        <Field invalid={invalid.has('reason')}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid.has('reason')}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <InvalidAlert show={invalid.size > 0} />
          <Button type="submit" disabled={grant.isPending}>
            {t('merchants.grant.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * MA7: back to a customer on retail, with a reason the customer never reads; re-authenticated.
 * Reservations on the merchant's list are cancelled; the balance and orders stay.
 */
export function RevokeMerchantDialog({
  customer,
  onDone,
}: {
  customer: { id: string; name: string };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeMerchant(customer.id);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = revokeMerchantSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await revoke.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.revoke.title', { name: customer.name })}</DialogTitle>
        <DialogDescription>{t('merchants.revoke.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={revoke.isPending}>
            {t('merchants.revoke.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
