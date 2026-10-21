import { type AdminCustomer, removeMerchantLogoSchema } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Textarea,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useRemoveMerchantLogo } from './merchants.queries';

type Branding = NonNullable<AdminCustomer['merchant']>['branding'];

/**
 * S21 BR3: the receipt branding the merchant set, on the customer profile: the WhatsApp number and
 * whether receipts show it, the logo's preview and "حذف الشعار" (a reason, re-authentication,
 * audited). The trade name above is the approved one.
 */
export function MerchantBranding({
  customerId,
  branding,
}: {
  customerId: string;
  branding: Branding;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-medium">{t('merchants.profile.branding')}</h4>
      <div className="flex flex-wrap items-start gap-4">
        {branding.logoFileId ? (
          <img
            // The logo id changes with each upload, so a new one is never served from the cache.
            key={branding.logoFileId}
            src={`/api/admin/customers/${customerId}/merchant/logo`}
            alt={t('merchants.profile.logoAlt')}
            className="size-20 rounded-md border border-border bg-white object-contain grayscale"
          />
        ) : (
          <span className="text-sm text-muted-foreground">{t('merchants.profile.noLogo')}</span>
        )}
        <div className="flex flex-col gap-2 text-sm">
          <span>
            {t('merchants.profile.whatsapp')}{' '}
            {branding.whatsapp ? (
              <bdi dir="ltr">{branding.whatsapp}</bdi>
            ) : (
              t('merchants.profile.noWhatsapp')
            )}
          </span>
          {branding.whatsapp && (
            <Badge tone={branding.showWhatsapp ? 'success' : 'neutral'} className="self-start">
              {t(
                branding.showWhatsapp
                  ? 'merchants.profile.whatsappShown'
                  : 'merchants.profile.whatsappHidden',
              )}
            </Badge>
          )}
          {branding.logoFileId && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setRemoving(true)}
            >
              {t('merchants.profile.removeLogo')}
            </Button>
          )}
        </div>
      </div>
      <Dialog open={removing} onOpenChange={setRemoving}>
        {removing && <RemoveLogoDialog customerId={customerId} onDone={() => setRemoving(false)} />}
      </Dialog>
    </div>
  );
}

function RemoveLogoDialog({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const remove = useRemoveMerchantLogo(customerId);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = removeMerchantLogoSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await remove.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.profile.removeTitle')}</DialogTitle>
        <DialogDescription>{t('merchants.profile.removeDescription')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={remove.isPending}>
            {t('merchants.profile.removeSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
