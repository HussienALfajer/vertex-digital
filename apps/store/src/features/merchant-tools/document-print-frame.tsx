'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { tm } from './i18n';

/** PR1: an A4 portrait page with margins; a constant rule, never data. */
const A4_RULE = '@page { size: A4 portrait; margin: 15mm; }';

/**
 * An A4 document's print page (S21 PR1: the price list, a statement): black on white, the site's
 * header and footer hidden (`globals.css`, `[data-print-page]`), an on-screen bar with the way
 * back and "طباعة / حفظ PDF" through the browser's dialog, hidden when printing.
 */
export function DocumentPrintFrame({
  back,
  ready,
  children,
}: {
  back: { href: string; label: string };
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-print-page
      className="flex flex-col items-center gap-6 bg-white px-4 py-6 text-neutral-950"
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant page rule, no input. */}
      <style dangerouslySetInnerHTML={{ __html: A4_RULE }} />
      <div className="flex w-full max-w-2xl flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-300 p-3 print:hidden">
        <Button variant="outline" size="xl" render={<Link href={back.href} prefetch={false} />}>
          {back.label}
        </Button>
        <Button size="xl" disabled={!ready} onClick={() => window.print()}>
          <PrinterIcon aria-hidden="true" />
          {tm('print.bar')}
        </Button>
      </div>
      <div className="w-full max-w-[180mm]">{children}</div>
    </div>
  );
}
