'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { acceptMerchantTerms, getMerchantApplication } from './requests';

/**
 * S20 MT2, decision 10: the merchant terms acceptance of a directly granted merchant, as a bottom
 * sheet: the link to `/merchant-terms`, the box to tick and the acceptance of the version in force.
 * Opened from the account page's banner and by any buy action the API refused with
 * `MERCHANT_TERMS_REQUIRED`.
 */
export function TermsSheet({
  open,
  onOpenChange,
  onAccepted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccepted: () => void;
}) {
  const checkId = useId();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    setFailure(null);
    void getMerchantApplication().then((result) => {
      if (result.ok) setVersionId(result.data.termsVersionId);
      else setFailure(result.reason);
    });
  }, [open]);

  async function accept() {
    if (!versionId) return;
    setSending(true);
    const result = await acceptMerchantTerms(versionId);
    setSending(false);
    if (!result.ok) return setFailure(result.reason);
    onOpenChange(false);
    onAccepted();
  }

  return (
    <Sheet open={open} guardTyped={false} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-4 bg-surface p-5 pb-8" data-testid="terms-sheet">
        <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
          <SheetTitle className="text-lg font-bold">{t('merchant.terms.title')}</SheetTitle>
          <p className="text-base text-muted-foreground">{t('merchant.terms.body')}</p>
          <Link
            href="/merchant-terms"
            target="_blank"
            prefetch={false}
            className="w-fit font-medium underline underline-offset-4"
          >
            {t('merchant.terms.read')}
          </Link>
          <label
            htmlFor={checkId}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2"
          >
            <Checkbox id={checkId} checked={checked} onCheckedChange={(next) => setChecked(next)} />
            <span className="text-base">{t('merchant.terms.check')}</span>
          </label>
          {failure && <FormAlert>{errorText(failure)}</FormAlert>}
          <Button
            size="xl"
            disabled={!checked || !versionId || sending}
            onClick={() => void accept()}
          >
            {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {sending ? t('merchant.terms.accepting') : t('merchant.terms.accept')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
