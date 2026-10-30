'use client';

import type { ContentPage, PublishedPage } from '@vertex-digital/contracts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { apiRequest } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';

// The rich text's parser and renderer load with the first press.
const ContentBody = dynamic(() => import('./content-body').then((module) => module.ContentBody), {
  loading: () => <Skeleton className="h-40 w-full" />,
});

type Read =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; page: PublishedPage };

/**
 * A published page (the merchant terms) read inside a dialog, from the same source as its own
 * route: a link would replace a half-filled form in an installed app or an in-app browser, where
 * `target="_blank"` opens in the same window. The press stops at the link's own label, so inside a
 * `<label>` it does not tick the box.
 */
export function ContentDialogLink({
  page,
  label,
  className,
}: {
  page: ContentPage;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>({ status: 'loading' });

  function show() {
    setOpen(true);
    setRead({ status: 'loading' });
    void apiRequest<PublishedPage>(`/api/content/pages/${page}`).then((result) =>
      setRead(
        result.ok
          ? { status: 'ready', page: result.data }
          : { status: 'failed', message: errorText(result.reason) },
      ),
    );
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          show();
        }}
      >
        {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          closeLabel={t('content.dialogClose')}
          className="max-h-[85dvh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{read.status === 'ready' ? read.page.title : label}</DialogTitle>
          </DialogHeader>
          {read.status === 'loading' && <Skeleton className="h-40 w-full" />}
          {read.status === 'failed' && <FormAlert>{read.message}</FormAlert>}
          {read.status === 'ready' && <ContentBody body={read.page.body} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
