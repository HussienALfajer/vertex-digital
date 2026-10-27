'use client';

import {
  MERCHANT_LOGO_MAX_BYTES,
  type OrderPrint,
  type ReceiptSettings,
  updateReceiptSettingsSchema,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Switch } from '@vertex-digital/ui/components/switch';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { CircleCheckIcon, ImageUpIcon, TrashIcon } from 'lucide-react';
import Link from 'next/link';
import { type ChangeEvent, type FormEvent, useCallback, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { ReceiptPrint } from './print-page';
import { getReceiptSettings, logoPath, saveReceiptSettings, uploadLogo } from './requests';

/** The 58 mm preview's order (S21 screens): sample facts, never a real order. */
const SAMPLE: Omit<OrderPrint, 'issuer' | 'whatsapp' | 'logoFileId'> = {
  orderId: '00000000-0000-7000-8000-000000000000',
  orderNumber: 'VO-7Q2M4K',
  stage: 'delivered',
  createdAt: '2026-10-21T09:30:00.000Z',
  game: { nameAr: 'ببجي موبايل' },
  product: { nameAr: '60 شدة', kind: 'direct', redemptionAr: null },
  quantity: 1,
  deliveredQuantity: 1,
  fields: [{ labelAr: 'معرّف اللاعب', value: '••••6789' }],
  price: {
    kind: 'selling',
    currency: 'syp',
    unitAmountUnits: 15_000_00,
    totalAmountUnits: 15_000_00,
  },
  verificationCode: 'AAAAAAAAAAAAAAAAAAAAAA',
};

/**
 * "إيصال محلّك" (S21 BR3): the approved trade name with "اطلب تعديلاً" (a ticket), the WhatsApp
 * number and whether receipts show it, the logo (uploaded on pick, removed by a save), and a live
 * preview of the 58 mm receipt.
 */
export function ReceiptPage() {
  const read = useCallback(() => getReceiptSettings(), []);
  const { state, setState, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  // An uploaded logo is the receipt's at once (BR3): it joins the saved settings in place, so a
  // WhatsApp number typed but not saved stays in the form (audit A06-11).
  return (
    <ReceiptForm
      saved={state.data}
      onSaved={(data) => setState({ status: 'ready', data })}
      onLogo={(logoFileId) => setState({ status: 'ready', data: { ...state.data, logoFileId } })}
    />
  );
}

function ReceiptForm({
  saved,
  onSaved,
  onLogo,
}: {
  saved: ReceiptSettings;
  onSaved: (settings: ReceiptSettings) => void;
  onLogo: (logoFileId: string) => void;
}) {
  const [whatsapp, setWhatsapp] = useState(saved.whatsapp ?? '');
  const [showWhatsapp, setShowWhatsapp] = useState(saved.showWhatsapp);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logoFailure, setLogoFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const switchId = useId();
  const { ref, focusInvalid } = useFocusInvalid();

  async function save(logoFileId: string | null) {
    setFailure(null);
    setDone(false);
    const parsed = updateReceiptSettingsSchema.safeParse({
      showWhatsapp,
      whatsapp: whatsapp.trim() === '' ? null : whatsapp,
      logoFileId,
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    setPending(true);
    const result = await saveReceiptSettings(parsed.data);
    setPending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    setDone(true);
    onSaved(result.data);
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoFailure(null);
    if (file.size > MERCHANT_LOGO_MAX_BYTES) return setLogoFailure(tm('receipt.logoTooBig'));
    setPending(true);
    const result = await uploadLogo(file);
    setPending(false);
    if (!result.ok) {
      return setLogoFailure(
        result.reason === 'IMAGE_INVALID' ? tm('receipt.logoInvalid') : errorText(result.reason),
      );
    }
    onLogo(result.data.fileId);
  }

  const preview: OrderPrint = {
    ...SAMPLE,
    issuer: { kind: 'merchant', tradeName: saved.tradeName },
    whatsapp: showWhatsapp && whatsapp.trim() ? whatsapp.trim() : null,
    logoFileId: saved.logoFileId,
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_auto]">
      <Card className="gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold">{tm('receipt.title')}</h2>
          <p className="text-sm text-muted-foreground">{tm('receipt.body')}</p>
        </div>
        <form
          ref={ref}
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void save(saved.logoFileId);
          }}
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">{tm('receipt.tradeName')}</span>
              <span className="text-base font-bold">
                <bdi>{saved.tradeName}</bdi>
              </span>
              <span className="text-xs text-muted-foreground">{tm('receipt.tradeNameHint')}</span>
            </div>
            <Button
              variant="outline"
              size="xl"
              render={<Link href="/support/new?category=account" prefetch={false} />}
            >
              {tm('receipt.requestChange')}
            </Button>
          </div>
          <Field invalid={invalid}>
            <FieldLabel>{tm('receipt.whatsapp')}</FieldLabel>
            <Input
              name="whatsapp"
              dir="ltr"
              inputMode="tel"
              autoComplete="tel"
              className="h-11 text-md"
              value={whatsapp}
              onChange={(event) => setWhatsapp(event.target.value)}
            />
            <FieldError match={invalid}>{tm('receipt.whatsappInvalid')}</FieldError>
          </Field>
          <label htmlFor={switchId} className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-base">{tm('receipt.showWhatsapp')}</span>
            <Switch id={switchId} checked={showWhatsapp} onCheckedChange={setShowWhatsapp} />
          </label>
          <Field>
            <FieldLabel>{tm('receipt.logo')}</FieldLabel>
            <div className="flex flex-wrap items-center gap-3">
              {saved.logoFileId && (
                // biome-ignore lint/performance/noImgElement: the merchant's own logo, served by the API (S21 BR3).
                <img
                  src={logoPath(saved.logoFileId)}
                  alt=""
                  width={64}
                  height={64}
                  className="size-16 rounded-md border border-border bg-white object-contain grayscale"
                />
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(event) => void pick(event)}
                aria-label={tm('receipt.logoUpload')}
              />
              <Button
                type="button"
                variant="outline"
                size="xl"
                disabled={pending}
                onClick={() => fileRef.current?.click()}
              >
                <ImageUpIcon aria-hidden="true" />
                {saved.logoFileId ? tm('receipt.logoReplace') : tm('receipt.logoUpload')}
              </Button>
              {saved.logoFileId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xl"
                  disabled={pending}
                  onClick={() => void save(null)}
                >
                  <TrashIcon aria-hidden="true" />
                  {tm('receipt.logoRemove')}
                </Button>
              )}
            </div>
            <FieldDescription>{tm('receipt.logoHint')}</FieldDescription>
          </Field>
          {logoFailure && <FormAlert>{logoFailure}</FormAlert>}
          {failure && <FormAlert>{failure}</FormAlert>}
          {done && (
            <p
              className="flex items-center gap-2 text-sm text-status-success-foreground"
              role="status"
            >
              <CircleCheckIcon className="size-4" aria-hidden="true" />
              {tm('receipt.saved')}
            </p>
          )}
          <Button type="submit" size="xl" disabled={pending} className="self-start">
            {tm('common.save')}
          </Button>
        </form>
      </Card>
      <div className="flex flex-col gap-2">
        <span className="text-sm text-muted-foreground">{tm('receipt.preview')}</span>
        <div className="w-[58mm] rounded-md bg-white p-2 shadow-sm" data-testid="receipt-preview">
          <ReceiptPrint print={preview} />
        </div>
      </div>
    </div>
  );
}
