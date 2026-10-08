import type { CatalogImage } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui';
import { ImageIcon, UploadIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { useUploadImage } from './catalog.queries';

/**
 * A catalog image field (rule CT10): uploaded at once, re-encoded by the API, previewed here; the
 * form saves the returned id. Removing it only clears the field: stored files are never deleted.
 */
export function ImageUpload({
  label,
  hint,
  image,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  image: CatalogImage | null;
  onChange: (image: CatalogImage | null) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const upload = useUploadImage();
  const input = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setFailure(null);
    try {
      onChange(await upload.mutateAsync(file));
    } catch (uploadError) {
      setFailure(errorMessage(t, uploadError));
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex aspect-video max-h-48 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted">
        {image ? (
          <img src={image.url} alt={label} className="size-full object-contain" />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {image ? t('catalog.image.size', { width: image.width, height: image.height }) : hint}
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        aria-label={label}
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
        >
          <UploadIcon />
          {upload.isPending
            ? t('catalog.image.uploading')
            : image
              ? t('catalog.image.replace')
              : t('catalog.image.upload')}
        </Button>
        {image && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <XIcon />
            {t('catalog.image.remove')}
          </Button>
        )}
      </div>
      {(failure || error) && (
        <p role="alert" className="text-sm text-destructive-text">
          {failure ?? error}
        </p>
      )}
    </fieldset>
  );
}
