'use client';

import { parseRichText } from '@vertex-digital/contracts';
import { RichText } from '@vertex-digital/ui/components/rich-text';

/** A published page's text in the browser (`ContentDialogLink`). */
export function ContentBody({ body }: { body: string }) {
  return <RichText blocks={parseRichText(body).blocks} />;
}
