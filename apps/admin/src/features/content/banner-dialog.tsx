import {
  BANNER_MIN_HEIGHT,
  BANNER_MIN_WIDTH,
  type Banner,
  bannerInputSchema,
  catalogImagePath,
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
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ImageIcon, UploadIcon } from 'lucide-react';
import { type DragEvent, type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { useSaveBanner, useUploadBannerImage } from './content.queries';
import { LinkWarnings, linkMarkdown, refusedFields, StorePreview } from './content-parts';
import { fromDamascusInput, toDamascusInput } from './damascus-time';

type BannerField = 'imageFileId' | 'altText' | 'linkPath' | 'startsAt' | 'endsAt';

/**
 * Add or edit a banner (S14 BN1, BN2, BN4): the image dropped or picked (uploaded at once and
 * checked by the API: 2:1, at least 1200 × 600), the alt text, an internal link, the schedule in
 * Damascus time and a preview at phone and desktop widths. A new banner is saved disabled.
 */
export function BannerDialog({ banner, onDone }: { banner: Banner | null; onDone: () => void }) {
  const { t } = useTranslation();
  const upload = useUploadBannerImage();
  const save = useSaveBanner();
  const input = useRef<HTMLInputElement>(null);
  const [imageId, setImageId] = useState(banner?.imageFileId ?? null);
  const [altText, setAltText] = useState(banner?.altText ?? '');
  const [linkPath, setLinkPath] = useState(banner?.linkPath ?? '');
  const imageErrorId = useId();
  const [errors, setErrors] = useState<Partial<Record<BannerField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  // The alert follows a refused save, not an upload refused on its own (shown under the image).
  const [refused, setRefused] = useState(false);

  async function choose(file: File | undefined) {
    // One upload at a time, so the image kept is the one chosen last (audit A08-18).
    if (!file || upload.isPending) return;
    setErrors((current) => ({ ...current, imageFileId: undefined }));
    try {
      setImageId((await upload.mutateAsync(file)).fileId);
    } catch (error) {
      setErrors((current) => ({ ...current, imageFileId: imageFailure(error) }));
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  /** BN2's refusals by reason; a decoder refusal or size limit reads as its code. */
  function imageFailure(error: unknown): string {
    const reason =
      error instanceof ApiError ? (error.details as { reason?: unknown })?.reason : null;
    if (reason === 'too_small' || reason === 'ratio')
      return t(`content.banners.imageErrors.${reason}`);
    return errorMessage(t, error);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setRefused(false);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const time = (name: string) =>
      text(name) ? (fromDamascusInput(text(name)) ?? 'invalid') : null;
    const parsed = bannerInputSchema.safeParse({
      imageFileId: imageId ?? '',
      altText,
      linkPath: text('linkPath') || null,
      startsAt: time('startsAt'),
      endsAt: time('endsAt'),
    });
    const found: typeof errors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = String(issue.path[0]) as BannerField;
      found[field] = t(`content.banners.errors.${field}`);
    }
    setErrors(found);
    if (!parsed.success) {
      setRefused(true);
      return focusInvalid();
    }
    try {
      await save.mutateAsync({ id: banner?.id, body: parsed.data });
      onDone();
    } catch (error) {
      const fields = refusedFields(error);
      if (fields.size === 0) {
        setFailure(errorMessage(t, error));
        return;
      }
      // BN4: a time in the past is refused unless it is the stored one.
      setErrors(
        Object.fromEntries(
          [...fields].map((field) => [
            field,
            field === 'startsAt' || field === 'endsAt'
              ? t('content.schedule.past')
              : t(`content.banners.errors.${field as BannerField}`),
          ]),
        ),
      );
      setRefused(true);
      focusInvalid();
    }
  }

  const url = imageId ? catalogImagePath(imageId) : null;
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-4xl">
      <DialogHeader>
        <DialogTitle>
          {banner ? t('content.banners.editTitle') : t('content.banners.add')}
        </DialogTitle>
        <DialogDescription>{t('content.banners.description')}</DialogDescription>
      </DialogHeader>
      <form
        ref={ref}
        className="grid items-start gap-6 lg:grid-cols-2"
        onSubmit={submit}
        noValidate
      >
        <div className="flex flex-col gap-5">
          <fieldset
            className="flex flex-col gap-2"
            data-invalid={errors.imageFileId ? '' : undefined}
          >
            <legend className="mb-2 text-sm font-medium">{t('content.banners.image')}</legend>
            <button
              type="button"
              data-testid="banner-drop"
              aria-label={url ? t('content.banners.replace') : t('content.banners.drop')}
              aria-invalid={errors.imageFileId ? true : undefined}
              aria-describedby={errors.imageFileId ? imageErrorId : undefined}
              disabled={upload.isPending}
              className="flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-border bg-muted text-muted-foreground hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => input.current?.click()}
              onDragOver={(event: DragEvent) => event.preventDefault()}
              onDrop={(event: DragEvent) => {
                event.preventDefault();
                void choose(event.dataTransfer.files[0]);
              }}
            >
              {url ? (
                <img src={url} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex flex-col items-center gap-2 px-4 text-center text-sm">
                  <ImageIcon className="size-8" aria-hidden="true" />
                  {t('content.banners.drop')}
                </span>
              )}
            </button>
            <p className="text-sm text-muted-foreground">
              {t('content.banners.guide', { width: BANNER_MIN_WIDTH, height: BANNER_MIN_HEIGHT })}
            </p>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              aria-label={t('content.banners.image')}
              onChange={(event) => void choose(event.target.files?.[0])}
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11"
                disabled={upload.isPending}
                onClick={() => input.current?.click()}
              >
                <UploadIcon />
                {upload.isPending
                  ? t('content.banners.uploading')
                  : url
                    ? t('content.banners.replace')
                    : t('content.banners.upload')}
              </Button>
            </div>
            {errors.imageFileId && (
              <p id={imageErrorId} role="alert" className="text-sm text-destructive-text">
                {errors.imageFileId}
              </p>
            )}
          </fieldset>
          <Field invalid={!!errors.altText}>
            <FieldLabel>{t('content.banners.alt')}</FieldLabel>
            <Input
              name="altText"
              value={altText}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => setAltText(event.target.value)}
            />
            <FieldDescription>{t('content.banners.altHint')}</FieldDescription>
            <FieldError match={!!errors.altText}>{errors.altText}</FieldError>
          </Field>
          <Field invalid={!!errors.linkPath}>
            <FieldLabel>{t('content.link')}</FieldLabel>
            <Input
              name="linkPath"
              dir="ltr"
              value={linkPath}
              placeholder="/games/pubg-mobile"
              maxLength={200}
              autoComplete="off"
              onChange={(event) => setLinkPath(event.target.value)}
            />
            <FieldDescription>{t('content.linkHint')}</FieldDescription>
            <LinkWarnings source={linkMarkdown(linkPath)} />
            <FieldError match={!!errors.linkPath}>{errors.linkPath}</FieldError>
          </Field>
          <ScheduleFields
            startsAt={banner?.startsAt ?? null}
            endsAt={banner?.endsAt ?? null}
            errors={errors}
          />
          {failure && <FormAlert>{failure}</FormAlert>}
          <InvalidAlert show={refused && Object.values(errors).some(Boolean)} />
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || upload.isPending}>
              {t('content.actions.save')}
            </Button>
          </DialogFooter>
        </div>
        <StorePreview>
          <div className="p-4">
            {url ? (
              <img
                src={url}
                alt={altText}
                className="aspect-[2/1] w-full rounded-lg object-cover"
              />
            ) : (
              <div className="flex aspect-[2/1] w-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                {t('content.banners.noImage')}
              </div>
            )}
          </div>
        </StorePreview>
      </form>
    </DialogContent>
  );
}

/** Start and end in Damascus time (BN4), shared by the banner and announcement forms. */
export function ScheduleFields({
  startsAt,
  endsAt,
  errors,
}: {
  startsAt: string | null;
  endsAt: string | null;
  errors: { startsAt?: string; endsAt?: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field invalid={!!errors.startsAt}>
        <FieldLabel>{t('content.schedule.start')}</FieldLabel>
        <Input
          type="datetime-local"
          name="startsAt"
          dir="ltr"
          defaultValue={startsAt ? toDamascusInput(startsAt) : ''}
        />
        <FieldDescription>{t('content.schedule.zone')}</FieldDescription>
        <FieldError match={!!errors.startsAt}>{errors.startsAt}</FieldError>
      </Field>
      <Field invalid={!!errors.endsAt}>
        <FieldLabel>{t('content.schedule.end')}</FieldLabel>
        <Input
          type="datetime-local"
          name="endsAt"
          dir="ltr"
          defaultValue={endsAt ? toDamascusInput(endsAt) : ''}
        />
        <FieldDescription>{t('content.schedule.zone')}</FieldDescription>
        <FieldError match={!!errors.endsAt}>{errors.endsAt}</FieldError>
      </Field>
    </div>
  );
}
