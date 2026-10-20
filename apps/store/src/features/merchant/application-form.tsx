'use client';

import {
  GOVERNORATES,
  HEARD_FROM,
  MERCHANT_ACTIVITIES,
  type MerchantApplication,
  MONTHLY_VOLUMES,
  PRODUCT_INTERESTS,
  SALES_CHANNELS,
  UPLOAD_MAX_BYTES,
  YEARS_IN_BUSINESS,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { ImageIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { useIdempotentRequest } from '@/lib/idempotency';
import {
  type DraftField,
  draftProblems,
  inputOf,
  type MerchantDraft,
  STEPS,
  type Step,
  toggled,
} from './form';
import {
  resubmitMerchantApplication,
  shopPhotoUrl,
  submitMerchantApplication,
  uploadShopPhoto,
} from './requests';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The application form (S20 MA2, screens): four short steps (المحل، التواصل، النشاط، الإثبات
 * والشروط), each checked before the next, then a summary before sending. A new application goes
 * with an `Idempotency-Key` per attempt; a resubmission (MA4) edits the waiting one.
 */
export function ApplicationForm({
  initial,
  contactName,
  termsVersionId,
  mode,
  onSent,
}: {
  initial: MerchantDraft;
  contactName: string;
  termsVersionId: string;
  mode: 'submit' | 'resubmit';
  onSent: (application: MerchantApplication) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [step, setStep] = useState<Step | 'summary'>('shop');
  const [shown, setShown] = useState<Set<Step>>(new Set());
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Failure | null>(null);
  const sendOnce = useIdempotentRequest();
  const { ref, focusInvalid } = useFocusInvalid();

  const change = (changes: Partial<MerchantDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));
  const visible = step === 'summary' ? [...STEPS] : [...shown];
  const problems = new Set<DraftField>(draftProblems(draft, termsVersionId, visible));
  const index = step === 'summary' ? STEPS.length : STEPS.indexOf(step);

  function next(event: FormEvent) {
    event.preventDefault();
    if (step === 'summary') return void send();
    setShown((current) => new Set(current).add(step));
    if (draftProblems(draft, termsVersionId, [step]).length > 0) return focusInvalid();
    setStep(STEPS[index + 1] ?? 'summary');
  }

  async function send() {
    setRefusal(null);
    if (draftProblems(draft, termsVersionId).length > 0) return focusInvalid();
    const input = inputOf(draft, termsVersionId);
    setSending(true);
    const result =
      mode === 'submit'
        ? await sendOnce(JSON.stringify(input), (key) => submitMerchantApplication(input, key))
        : await resubmitMerchantApplication(input);
    setSending(false);
    if (result.ok) return onSent(result.data);
    setRefusal(result.reason);
  }

  return (
    <form ref={ref} className="flex flex-col gap-6" noValidate onSubmit={next}>
      <ol
        className="flex gap-2"
        aria-label={t('merchant.stepOf', {
          current: Math.min(index + 1, STEPS.length),
          total: STEPS.length,
        })}
      >
        {STEPS.map((name, position) => (
          <li
            key={name}
            aria-current={name === step ? 'step' : undefined}
            className="flex flex-1 flex-col gap-1.5"
          >
            <span className={`h-1 rounded-sm ${position <= index ? 'bg-primary' : 'bg-border'}`} />
            <span
              className={`text-xs ${name === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {t(`merchant.steps.${name}`)}
            </span>
          </li>
        ))}
      </ol>

      {step === 'shop' && <ShopStep draft={draft} problems={problems} change={change} />}
      {step === 'contact' && (
        <ContactStep draft={draft} problems={problems} change={change} contactName={contactName} />
      )}
      {step === 'activity' && <ActivityStep draft={draft} problems={problems} change={change} />}
      {step === 'proof' && <ProofStep draft={draft} problems={problems} change={change} />}
      {step === 'summary' && <Summary draft={draft} contactName={contactName} onEdit={setStep} />}

      {refusal && <FormAlert>{errorText(refusal)}</FormAlert>}
      <InvalidAlert show={problems.size > 0} />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        {index > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="xl"
            disabled={sending}
            onClick={() => setStep(STEPS[index - 1] as Step)}
          >
            {t('merchant.back')}
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" size="xl" disabled={sending}>
          {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {sending
            ? t('merchant.sending')
            : step === 'summary'
              ? t(mode === 'submit' ? 'merchant.submit' : 'merchant.resubmit')
              : step === 'proof'
                ? t('merchant.review')
                : t('merchant.next')}
        </Button>
      </div>
    </form>
  );
}

interface StepProps {
  draft: MerchantDraft;
  problems: Set<DraftField>;
  change: (changes: Partial<MerchantDraft>) => void;
}

/** A text field with its label, hint and refusal. */
function TextField({
  name,
  value,
  problems,
  onChange,
  hint,
  dir,
  inputMode,
}: {
  name: DraftField;
  value: string;
  problems: Set<DraftField>;
  onChange: (value: string) => void;
  hint?: string;
  dir?: 'ltr';
  inputMode?: 'tel' | 'url';
}) {
  return (
    <Field invalid={problems.has(name)}>
      <FieldLabel>{t(`merchant.fields.${name as 'tradeName'}`)}</FieldLabel>
      <Input
        value={value}
        dir={dir}
        inputMode={inputMode}
        autoComplete="off"
        className="h-11 text-md"
        aria-invalid={problems.has(name)}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <FieldDescription>{hint}</FieldDescription>}
      <FieldError match={problems.has(name)}>
        {t(`merchant.validation.${name as 'tradeName'}`)}
      </FieldError>
    </Field>
  );
}

/** One choice from a list, as a select. */
function ChoiceField<Value extends string>({
  name,
  values,
  labels,
  value,
  problems,
  onChange,
}: {
  name: DraftField;
  values: readonly Value[];
  labels: (value: Value) => string;
  value: Value | null;
  problems: Set<DraftField>;
  onChange: (value: Value) => void;
}) {
  const items = values.map((item) => ({ value: item, label: labels(item) }));
  return (
    <Field invalid={problems.has(name)}>
      <FieldLabel render={<span />}>{t(`merchant.fields.${name as 'activity'}`)}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => next && onChange(next as Value)}>
        <SelectTrigger
          aria-label={t(`merchant.fields.${name as 'activity'}`)}
          aria-invalid={problems.has(name)}
          className="h-11 w-full text-md"
        >
          <SelectValue placeholder={t('merchant.fields.choose')} />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError match={problems.has(name)}>
        {t(`merchant.validation.${name as 'activity'}`)}
      </FieldError>
    </Field>
  );
}

/** Several choices from a list, as checkboxes in a fieldset. */
function ChecksField<Value extends string>({
  name,
  values,
  labels,
  value,
  problems,
  onChange,
}: {
  name: DraftField;
  values: readonly Value[];
  labels: (value: Value) => string;
  value: readonly Value[];
  problems: Set<DraftField>;
  onChange: (value: Value[]) => void;
}) {
  const id = useId();
  return (
    <fieldset
      className="flex flex-col gap-2"
      data-invalid={problems.has(name) || undefined}
      aria-invalid={problems.has(name)}
    >
      <legend className="mb-2 text-sm font-medium">
        {t(`merchant.fields.${name as 'productInterests'}`)}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {values.map((item) => (
          <label
            key={item}
            htmlFor={`${id}-${item}`}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3"
          >
            <Checkbox
              id={`${id}-${item}`}
              checked={value.includes(item)}
              onCheckedChange={(checked) => onChange(toggled(value, item, checked))}
            />
            <span className="text-base">{labels(item)}</span>
          </label>
        ))}
      </div>
      {problems.has(name) && (
        <p className="text-sm text-destructive-text">
          {t(`merchant.validation.${name as 'productInterests'}`)}
        </p>
      )}
    </fieldset>
  );
}

function ShopStep({ draft, problems, change }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <TextField
        name="tradeName"
        value={draft.tradeName}
        problems={problems}
        onChange={(tradeName) => change({ tradeName })}
      />
      <ChoiceField
        name="activity"
        values={MERCHANT_ACTIVITIES}
        labels={(value) => t(`merchant.activities.${value}`)}
        value={draft.activity}
        problems={problems}
        onChange={(activity) => change({ activity })}
      />
      {draft.activity === 'other' && (
        <TextField
          name="activityOther"
          value={draft.activityOther}
          problems={problems}
          onChange={(activityOther) => change({ activityOther })}
        />
      )}
      <Field invalid={problems.has('yearsInBusiness')}>
        <FieldLabel render={<span />}>{t('merchant.fields.yearsInBusiness')}</FieldLabel>
        <ToggleGroup
          aria-label={t('merchant.fields.yearsInBusiness')}
          className="grid w-full grid-cols-3 gap-2 border-0 bg-transparent p-0"
          value={draft.yearsInBusiness ? [draft.yearsInBusiness] : []}
          onValueChange={(value) => {
            const years = value[0];
            if (years) change({ yearsInBusiness: years });
          }}
        >
          {YEARS_IN_BUSINESS.map((years) => (
            <ToggleGroupItem
              key={years}
              value={years}
              className="h-auto min-h-11 rounded-md border border-border bg-surface px-2 py-2 text-sm whitespace-normal"
            >
              {t(`merchant.years.${years}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldError match={problems.has('yearsInBusiness')}>
          {t('merchant.validation.yearsInBusiness')}
        </FieldError>
      </Field>
      <ChoiceField
        name="governorate"
        values={GOVERNORATES}
        labels={(value) => t(`merchant.governorates.${value}`)}
        value={draft.governorate}
        problems={problems}
        onChange={(governorate) => change({ governorate })}
      />
      <TextField
        name="city"
        value={draft.city}
        problems={problems}
        onChange={(city) => change({ city })}
      />
      <TextField
        name="streetAddress"
        value={draft.streetAddress}
        problems={problems}
        hint={t('merchant.fields.streetAddressHint')}
        onChange={(streetAddress) => change({ streetAddress })}
      />
    </div>
  );
}

function ContactStep({
  draft,
  problems,
  change,
  contactName,
}: StepProps & { contactName: string }) {
  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel>{t('merchant.fields.contactName')}</FieldLabel>
        <Input value={contactName} readOnly className="h-11 text-md" />
        <FieldDescription>{t('merchant.fields.contactNameHint')}</FieldDescription>
      </Field>
      <TextField
        name="whatsapp"
        value={draft.whatsapp}
        problems={problems}
        dir="ltr"
        inputMode="tel"
        onChange={(whatsapp) => change({ whatsapp })}
      />
      <TextField
        name="telegramUsername"
        value={draft.telegramUsername}
        problems={problems}
        dir="ltr"
        hint={t('merchant.fields.telegramUsernameHint')}
        onChange={(telegramUsername) => change({ telegramUsername })}
      />
    </div>
  );
}

function ActivityStep({ draft, problems, change }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <ChoiceField
        name="monthlyVolume"
        values={MONTHLY_VOLUMES}
        labels={(value) => t(`merchant.volumes.${value}`)}
        value={draft.monthlyVolume}
        problems={problems}
        onChange={(monthlyVolume) => change({ monthlyVolume })}
      />
      <ChecksField
        name="productInterests"
        values={PRODUCT_INTERESTS}
        labels={(value) => t(`merchant.interests.${value}`)}
        value={draft.productInterests}
        problems={problems}
        onChange={(productInterests) => change({ productInterests })}
      />
      <ChecksField
        name="salesChannels"
        values={SALES_CHANNELS}
        labels={(value) => t(`merchant.channels.${value}`)}
        value={draft.salesChannels}
        problems={problems}
        onChange={(salesChannels) => change({ salesChannels })}
      />
      <ChoiceField
        name="heardFrom"
        values={HEARD_FROM}
        labels={(value) => t(`merchant.heard.${value}`)}
        value={draft.heardFrom}
        problems={problems}
        onChange={(heardFrom) => change({ heardFrom })}
      />
    </div>
  );
}

function ProofStep({ draft, problems, change }: StepProps) {
  const termsId = useId();
  const [before, after] = [t('merchant.fields.termsBefore'), t('merchant.fields.termsAfter')];
  return (
    <div className="flex flex-col gap-5">
      <PhotoField
        fileId={draft.shopPhotoFileId}
        invalid={problems.has('shopPhotoFileId')}
        onChange={(shopPhotoFileId) => change({ shopPhotoFileId })}
      />
      <TextField
        name="shopLink"
        value={draft.shopLink}
        problems={problems}
        dir="ltr"
        inputMode="url"
        hint={t('merchant.fields.shopLinkHint')}
        onChange={(shopLink) => change({ shopLink })}
      />
      <div className="flex flex-col gap-2" data-invalid={problems.has('terms') || undefined}>
        <label
          htmlFor={termsId}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2"
        >
          <Checkbox
            id={termsId}
            checked={draft.termsAccepted}
            aria-invalid={problems.has('terms')}
            onCheckedChange={(termsAccepted) => change({ termsAccepted })}
          />
          <span className="text-base">
            {before}{' '}
            <Link
              href="/merchant-terms"
              target="_blank"
              prefetch={false}
              className="font-medium underline underline-offset-4"
            >
              {t('merchant.fields.termsLink')}
            </Link>{' '}
            {after}
          </span>
        </label>
        {problems.has('terms') && (
          <p className="text-sm text-destructive-text">{t('merchant.validation.terms')}</p>
        )}
      </div>
    </div>
  );
}

/** MA3: one photo, uploaded when picked; the stored file is what the preview shows. */
function PhotoField({
  fileId,
  invalid,
  onChange,
}: {
  fileId: string | null;
  invalid: boolean;
  onChange: (fileId: string | null) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    if (!PHOTO_TYPES.includes(file.type) || file.size > UPLOAD_MAX_BYTES) {
      return setProblem(t('merchant.validation.photo'));
    }
    setUploading(true);
    const result = await uploadShopPhoto(file);
    setUploading(false);
    if (result.ok) return onChange(result.data.fileId);
    setProblem(
      result.reason === 'IMAGE_INVALID' || result.reason === 'PAYLOAD_TOO_LARGE'
        ? t('merchant.validation.photo')
        : errorText(result.reason),
    );
  }

  return (
    <div className="flex flex-col gap-2" data-invalid={invalid || problem !== null || undefined}>
      <p className="text-sm font-medium">{t('merchant.fields.shopPhoto')}</p>
      <p className="text-sm text-muted-foreground">{t('merchant.fields.shopPhotoHint')}</p>
      <input
        ref={picker}
        type="file"
        accept={PHOTO_TYPES.join(',')}
        className="hidden"
        data-testid="shop-photo-input"
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {fileId && (
        <div className="relative w-fit">
          {/* biome-ignore lint/performance/noImgElement: the customer's own photo, never cached. */}
          <img
            src={shopPhotoUrl(fileId)}
            alt={t('merchant.fields.shopPhoto')}
            className="h-32 w-auto rounded-lg border border-border object-cover"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="absolute end-2 top-2"
            aria-label={t('merchant.fields.removePhoto')}
            onClick={() => onChange(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="xl"
        className="w-fit"
        disabled={uploading}
        onClick={() => picker.current?.click()}
      >
        {uploading ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
        {uploading
          ? t('merchant.fields.uploading')
          : fileId
            ? t('merchant.fields.changePhoto')
            : t('merchant.fields.choosePhoto')}
      </Button>
      {(problem || invalid) && (
        <p className="text-sm text-destructive-text">
          {problem ?? t('merchant.validation.shopPhotoFileId')}
        </p>
      )}
    </div>
  );
}

/** The summary before sending, each step with its edit link. */
function Summary({
  draft,
  contactName,
  onEdit,
}: {
  draft: MerchantDraft;
  contactName: string;
  onEdit: (step: Step) => void;
}) {
  const rows: Record<Step, [string, string][]> = {
    shop: [
      [t('merchant.fields.tradeName'), draft.tradeName],
      [
        t('merchant.fields.activity'),
        draft.activity === 'other'
          ? draft.activityOther
          : draft.activity
            ? t(`merchant.activities.${draft.activity}`)
            : '',
      ],
      [
        t('merchant.fields.yearsInBusiness'),
        draft.yearsInBusiness ? t(`merchant.years.${draft.yearsInBusiness}`) : '',
      ],
      [
        t('merchant.fields.governorate'),
        draft.governorate ? t(`merchant.governorates.${draft.governorate}`) : '',
      ],
      [t('merchant.fields.city'), draft.city],
      [t('merchant.fields.streetAddress'), draft.streetAddress],
    ],
    contact: [
      [t('merchant.fields.contactName'), contactName],
      [t('merchant.fields.whatsapp'), draft.whatsapp],
      [t('merchant.fields.telegramUsername'), draft.telegramUsername],
    ],
    activity: [
      [
        t('merchant.fields.monthlyVolume'),
        draft.monthlyVolume ? t(`merchant.volumes.${draft.monthlyVolume}`) : '',
      ],
      [
        t('merchant.fields.productInterests'),
        draft.productInterests.map((item) => t(`merchant.interests.${item}`)).join('، '),
      ],
      [
        t('merchant.fields.salesChannels'),
        draft.salesChannels.map((item) => t(`merchant.channels.${item}`)).join('، '),
      ],
    ],
    proof: [
      [
        t('merchant.fields.shopPhoto'),
        draft.shopPhotoFileId ? t('merchant.fields.photoAttached') : '',
      ],
      [t('merchant.fields.shopLink'), draft.shopLink],
    ],
  };
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-bold">{t('merchant.summaryTitle')}</h2>
      {STEPS.map((step) => (
        <section key={step} className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">{t(`merchant.steps.${step}`)}</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(step)}>
              {t('merchant.edit')}
            </Button>
          </div>
          <dl className="grid gap-1 text-sm">
            {rows[step]
              .filter(([, value]) => value !== '')
              .map(([label, value]) => (
                <div key={label} className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">{label}:</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
