import { TICKET_LIMITS } from '@vertex-digital/contracts';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import { ImagePlusIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addImages, IMAGE_TYPES, type ImageRefusal } from './ticket-labels';

/** A file as a `data:` URL: the panel's CSP allows `data:` images, not `blob:`. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Up to 3 images for a ticket message (TK11), previewed from the files and removable one by one;
 * files of another type, over 5 MB or past the third are refused here with their reason (the API
 * checks again and re-encodes them).
 */
export function ImagePicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [refused, setRefused] = useState<{ name: string; reason: ImageRefusal }[]>([]);

  useEffect(() => {
    let current = true;
    Promise.all(files.map(readAsDataUrl)).then(
      (urls) => current && setPreviews(urls),
      () => current && setPreviews([]),
    );
    return () => {
      current = false;
    };
  }, [files]);

  function pick(list: FileList | null) {
    const result = addImages(files, Array.from(list ?? []));
    setRefused(result.refused);
    onChange(result.files);
    if (input.current) input.current.value = '';
  }

  function remove(index: number) {
    setRefused([]);
    onChange(files.filter((_, position) => position !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {files.map((file, index) => (
          <div
            key={`${file.name}-${file.size}-${file.lastModified}`}
            className="relative size-20 overflow-hidden rounded-md border border-border bg-muted"
          >
            {previews[index] && (
              <img
                src={previews[index]}
                alt={t('support.images.preview', { n: index + 1 })}
                className="size-full object-cover"
              />
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="absolute end-1 top-1"
                    aria-label={t('support.images.remove', { n: index + 1 })}
                    disabled={disabled}
                    onClick={() => remove(index)}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>{t('support.images.remove', { n: index + 1 })}</TooltipContent>
            </Tooltip>
          </div>
        ))}
        {files.length < TICKET_LIMITS.imagesPerMessage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <ImagePlusIcon />
            {t('support.images.add')}
          </Button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept={IMAGE_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          aria-label={t('support.images.add')}
          onChange={(event) => pick(event.target.files)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t('support.images.hint')}</p>
      {refused.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive-text">
          {refused.map((item) => (
            <li key={`${item.name}-${item.reason}`}>
              {t(`support.images.${item.reason}`, { name: item.name })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
