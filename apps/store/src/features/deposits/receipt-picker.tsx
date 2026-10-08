'use client';

import { UPLOAD_MAX_BYTES } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { CameraIcon, ClipboardPasteIcon, ImageIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';

/** What the API decodes (rule SC8); HEIC and PDF are out of V1 (edge case 14). */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

/** Why a file cannot be the receipt, before it is sent; null when it can. */
export function receiptProblem(file: { type: string; size: number }): string | null {
  if (!ACCEPTED.includes(file.type)) return errorText('RECEIPT_INVALID');
  if (file.size > UPLOAD_MAX_BYTES) return errorText('PAYLOAD_TOO_LARGE');
  return null;
}

/**
 * The receipt, by paste (`Ctrl+V` anywhere on the page, or the paste button), the file picker or
 * the camera, with a preview before it is sent (S03 screens). A clipboard without an image is
 * ignored with a hint (edge case 15).
 */
export function ReceiptPicker({
  file,
  onFile,
  disabled,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // A data URL, which the store's CSP allows for images (`img-src 'self' data:`); blob URLs are not.
  useEffect(() => {
    setPreview(null);
    if (!file) return;
    let active = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (active && typeof reader.result === 'string') setPreview(reader.result);
    };
    reader.readAsDataURL(file);
    return () => {
      active = false;
      reader.abort();
    };
  }, [file]);

  const choose = (candidate: File | null | undefined) => {
    if (!candidate) return;
    const problem = receiptProblem(candidate);
    setHint(problem);
    if (!problem) onFile(candidate);
  };

  // Pasting anywhere on the page while the receipt is awaited (the spec: Ctrl+V).
  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const items = [...(event.clipboardData?.items ?? [])];
      const image = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      if (!image) return setHint(t('deposits.receipt.noImage'));
      event.preventDefault();
      choose(image.getAsFile());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          return choose(new File([blob], 'receipt', { type }));
        }
      }
      setHint(t('deposits.receipt.noImage'));
    } catch {
      // Browsers that do not let a page read the clipboard still deliver Ctrl+V.
      setHint(t('deposits.receipt.pasteHint'));
    }
  }

  const fileInput = (ref: typeof picker, capture: boolean) => (
    <input
      ref={ref}
      type="file"
      accept={capture ? 'image/*' : ACCEPTED.join(',')}
      capture={capture ? 'environment' : undefined}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      disabled={disabled}
      onChange={(event) => {
        choose(event.target.files?.[0]);
        event.target.value = '';
      }}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {preview ? (
        <div className="relative flex justify-center rounded-lg border border-border bg-muted p-2">
          {/* biome-ignore lint/performance/noImgElement: a local data URL, not an optimizable asset. */}
          <img
            src={preview}
            alt={t('deposits.receipt.preview')}
            className="max-h-80 rounded-md object-contain"
          />
          <Button
            type="button"
            variant="outline"
            size="xl"
            className="absolute end-2 top-2 px-3"
            disabled={disabled}
            onClick={() => onFile(null)}
          >
            <XIcon />
            {t('deposits.receipt.remove')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-6 text-center">
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('deposits.receipt.prompt')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xl"
              disabled={disabled}
              onClick={() => void pasteFromClipboard()}
            >
              <ClipboardPasteIcon />
              {t('deposits.receipt.paste')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xl"
              disabled={disabled}
              onClick={() => picker.current?.click()}
            >
              <ImageIcon />
              {t('deposits.receipt.pick')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xl"
              disabled={disabled}
              onClick={() => camera.current?.click()}
            >
              <CameraIcon />
              {t('deposits.receipt.camera')}
            </Button>
          </div>
        </div>
      )}
      {fileInput(picker, false)}
      {fileInput(camera, true)}
      {hint && (
        <p role="status" className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
