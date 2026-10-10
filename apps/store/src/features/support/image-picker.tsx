'use client';

import { TICKET_LIMITS } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { CameraIcon, ImageIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { IMAGE_TYPES, imageProblem } from './form';

/** A data URL per file, which the store's CSP allows for images (`img-src 'self' data:`). */
function usePreviews(files: File[]): (string | null)[] {
  const [previews, setPreviews] = useState<Map<File, string>>(new Map());
  useEffect(() => {
    let active = true;
    const readers = files
      .filter((file) => !previews.has(file))
      .map((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (active && typeof reader.result === 'string') {
            const url = reader.result;
            setPreviews((current) => new Map(current).set(file, url));
          }
        };
        reader.readAsDataURL(file);
        return reader;
      });
    return () => {
      active = false;
      for (const reader of readers) reader.abort();
    };
  }, [files, previews]);
  return files.map((file) => previews.get(file) ?? null);
}

/**
 * A ticket's or a message's images (S12 TK11): picked or taken with the camera, up to 3, each
 * previewed with a remove button. A file that cannot go is refused here with its own reason;
 * the others are kept.
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
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const previews = usePreviews(files);
  const full = files.length >= TICKET_LIMITS.imagesPerMessage;

  const add = (chosen: File[]) => {
    const next = [...files];
    const refused: string[] = [];
    for (const file of chosen) {
      const problem = imageProblem(file);
      if (problem) refused.push(t(`support.images.${problem}`, { name: file.name }));
      else if (next.length >= TICKET_LIMITS.imagesPerMessage) {
        refused.push(t('support.images.tooMany'));
        break;
      } else next.push(file);
    }
    setProblems(refused);
    if (next.length !== files.length) onChange(next);
  };

  const fileInput = (ref: typeof picker, capture: boolean) => (
    <input
      ref={ref}
      type="file"
      multiple={!capture}
      accept={capture ? 'image/*' : IMAGE_TYPES.join(',')}
      capture={capture ? 'environment' : undefined}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      disabled={disabled}
      data-testid={capture ? 'ticket-camera' : 'ticket-images'}
      onChange={(event) => {
        add([...(event.target.files ?? [])]);
        event.target.value = '';
      }}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {files.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {files.map((file, index) => {
            const preview = previews[index];
            const n = index + 1;
            return (
              <li
                key={`${file.name}:${file.size}:${file.lastModified}:${n}`}
                className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted"
              >
                {preview && (
                  // biome-ignore lint/performance/noImgElement: a local data URL, not an optimizable asset.
                  <img
                    src={preview}
                    alt={t('support.images.preview', { n })}
                    className="size-full object-cover"
                  />
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute end-1 top-1 size-11 bg-surface"
                  aria-label={t('support.images.remove', { n })}
                  disabled={disabled}
                  onClick={() => {
                    setProblems([]);
                    onChange(files.filter((_, at) => at !== index));
                  }}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!full && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="xl"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <ImageIcon />
            {t('support.images.pick')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xl"
            disabled={disabled}
            onClick={() => camera.current?.click()}
          >
            <CameraIcon />
            {t('support.images.camera')}
          </Button>
        </div>
      )}
      {fileInput(picker, false)}
      {fileInput(camera, true)}
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive-text">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
