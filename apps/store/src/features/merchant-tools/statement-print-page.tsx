'use client';

import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { getStatement } from './requests';
import { StatementDocument } from './statement-document';

/** `/merchant/statements/[month]/print` (S21 ST3, PR1): the month's statement on A4. */
export function StatementPrintPage() {
  const { month } = useParams<{ month: string }>();
  const read = useCallback(() => getStatement(month), [month]);
  const { state, reload } = useMerchantRead(read);
  return (
    <DocumentPrintFrame
      back={{ href: `/merchant/statements/${month}`, label: tm('statements.backToMonth') }}
      ready={state.status === 'ready'}
    >
      {state.status === 'ready' ? (
        <StatementDocument statement={state.data} />
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
