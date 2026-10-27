'use client';

import type { Statement } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import type { Result } from '@/lib/api';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { getStatement } from './requests';
import { StatementDocument } from './statement-document';
import { InvalidMonth } from './statements-page';

/** `/merchant/statements/[month]/print` (S21 ST3, PR1): the month's statement on A4. */
export function StatementPrintPage() {
  const { month } = useParams<{ month: string }>();
  // A month outside the account is its own page, never a failure to retry (audit A06-18).
  const read = useCallback(async (): Promise<Result<Statement | null>> => {
    const result = await getStatement(month);
    if (!result.ok && result.reason === 'STATEMENT_MONTH_INVALID') return { ok: true, data: null };
    return result;
  }, [month]);
  const { state, reload } = useMerchantRead(read);
  if (state.status === 'ready' && state.data === null) return <InvalidMonth />;
  return (
    <DocumentPrintFrame
      back={{ href: `/merchant/statements/${month}`, label: tm('statements.backToMonth') }}
      ready={state.status === 'ready'}
    >
      {state.status === 'ready' ? (
        state.data && <StatementDocument statement={state.data} />
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<Skeleton className="h-96 w-full" />}
        />
      )}
    </DocumentPrintFrame>
  );
}
