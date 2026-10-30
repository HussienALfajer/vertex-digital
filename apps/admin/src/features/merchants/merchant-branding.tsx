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
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useRemoveMerchantLogo, useRemoveWelcomeText } from './merchants.queries';

type Branding = NonNullable<AdminCustomer['merchant']>['branding'];

/**
 * S21 BR3: the receipt branding the merchant set, on the customer profile: the WhatsApp number and
 * whether receipts show it, the logo's preview and "حذف الشعار" (a reason, re-authentication,
 * audited). The trade name above is the approved one. S23 RC1: the welcome line and its "حذف",
 * the same way (a line used for scam contacts).
 */
export function MerchantBranding({
  customerId,
  branding,
}: {
  customerId: string;
  branding: Branding;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState<'logo' | 'welcome' | null>(null);
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
              onClick={() => setRemoving('logo')}
            >
              {t('merchants.profile.removeLogo')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {t('merchants.profile.welcomeText')}{' '}
          {branding.welcomeText ? (
            <bdi data-testid="merchant-welcome-text">{branding.welcomeText}</bdi>
          ) : (
            t('merchants.profile.noWelcomeText')
          )}
        </span>
        {branding.welcomeText && (
          <Button variant="outline" size="sm" onClick={() => setRemoving('welcome')}>
            {t('merchants.profile.removeWelcome')}
          </Button>
        )}
      </div>
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        {removing && (
          <RemoveDialog customerId={customerId} what={removing} onDone={() => setRemoving(null)} />
        )}
      </Dialog>
    </div>
  );
}

function RemoveDialog({
  customerId,
  what,
  onDone,
}: {
  customerId: string;
  what: 'logo' | 'welcome';
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const removeLogo = useRemoveMerchantLogo(customerId);
  const removeWelcome = useRemoveWelcomeText(customerId);
  const remove = what === 'logo' ? removeLogo : removeWelcome;
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = removeMerchantLogoSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
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
        <DialogTitle>
          {t(
            what === 'logo'
              ? 'merchants.profile.removeTitle'
              : 'merchants.profile.removeWelcomeTitle',
          )}
        </DialogTitle>
        <DialogDescription>
          {t(
            what === 'logo'
              ? 'merchants.profile.removeDescription'
              : 'merchants.profile.removeWelcomeDescription',
          )}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={remove.isPending}>
            {t(
              what === 'logo'
                ? 'merchants.profile.removeSubmit'
                : 'merchants.profile.removeWelcome',
            )}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
