'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import { UndoDotIcon } from 'lucide-react';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useIdempotentRequest } from '@/lib/idempotency';
import { ts } from './i18n';
import { balanceSyp, ShopMoney } from './money';
import { answerReturnRequest } from './requests';
import { useShopCustomer } from './session';
import { refreshShopWallet, useShopWallet } from './wallet';

type Answer =
  | { status: 'idle' }
  | { status: 'sending'; answer: 'confirm' | 'decline' }
  | { status: 'done'; answer: 'confirm' | 'decline' }
  | { status: 'failed'; message: string };

/**
 * WL5, WL6: the merchant's pending return request at the top of the shop and the wallet. "تأكيد"
 * (a slide: real money moves back to the merchant, who pays cash) or "رفض". A refused confirm
 * (the balance fell below the amount, `INSUFFICIENT_BALANCE`) leaves the request pending.
 */
export function ReturnRequestCard({ slug }: { slug: string }) {
  const customer = useShopCustomer(slug);
  const { state } = useShopWallet(slug, customer.status === 'signedIn');
  const send = useIdempotentRequest();
  const [answer, setAnswer] = useState<Answer>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  if (answer.status === 'done') {
    return (
      <FormAlert tone="success">
        {ts(answer.answer === 'confirm' ? 'return.confirmed' : 'return.declined')}
      </FormAlert>
    );
  }
  if (state.status !== 'ready' || !state.wallet.pendingReturn) return null;
  const request = state.wallet.pendingReturn;
  const amountSyp = balanceSyp(request.amountUsdUnits, state.wallet.rate);
  const frozen = customer.status === 'signedIn' && customer.profile.frozen;

  async function respond(next: 'confirm' | 'decline') {
    setAnswer({ status: 'sending', answer: next });
    const result = await send(`${request.id}:${next}`, (key) =>
      answerReturnRequest(slug, request.id, next, key),
    );
    if (result.ok) {
      setAnswer({ status: 'done', answer: next });
      void refreshShopWallet(slug);
      return;
    }
    setSlide((count) => count + 1);
    setAnswer({ status: 'failed', message: errorText(result.reason) });
    if (result.reason === 'RETURN_REQUEST_STATE_INVALID') void refreshShopWallet(slug);
  }

  const sending = answer.status === 'sending';
  return (
    <section
      aria-labelledby="return-title"
      className="flex flex-col gap-3 rounded-xl border-2 border-(--shop-brand) bg-surface p-4"
    >
      <h2 id="return-title" className="flex items-center gap-2 text-lg font-bold">
        <UndoDotIcon className="size-5 text-(--shop-brand)" aria-hidden="true" />
        {ts('return.title')}
      </h2>
      <ShopMoney usd={request.amountUsdUnits} syp={amountSyp} size="lg" />
      <p className="text-sm text-muted-foreground">{ts('return.body')}</p>
      <p className="text-xs text-muted-foreground">
        {ts('return.expires', { time: formatDateTime(request.expiresAt) })}
      </p>
      {answer.status === 'failed' && <FormAlert>{answer.message}</FormAlert>}
      {frozen ? (
        <FormAlert>{errorText('ACCOUNT_FROZEN')}</FormAlert>
      ) : (
        <>
          <SlideToPay
            key={slide}
            label={ts('return.slide')}
            valueText={(percent) => t('purchase.slideValue', { percent })}
            disabled={sending}
            onConfirm={() => void respond('confirm')}
          />
          <Button
            variant="outline"
            size="xl"
            disabled={sending}
            onClick={() => void respond('decline')}
          >
            {sending && answer.answer === 'decline' ? ts('return.declining') : ts('return.decline')}
          </Button>
        </>
      )}
    </section>
  );
}
