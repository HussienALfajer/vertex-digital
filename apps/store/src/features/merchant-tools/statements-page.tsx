'use client';

import type { Statement } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { CalendarX2Icon, FileSpreadsheetIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure, Result } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { saveBlob } from './download';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { exportStatement, getStatement, getStatements } from './requests';
import { monthLabel, StatementDocument } from './statement-document';

/** "كشف الحساب" (S21 ST1): the months from the account's creation to this month, newest first. */
export function StatementsPage() {
  const { state, reload } = useMerchantRead(getStatements);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton rows={3} />}
      />
    );
  }
  return (
    <Card className="gap-0 p-0">
      <h2 className="px-4 pt-4 pb-2 text-lg font-bold sm:px-6">{tm('statements.months')}</h2>
      <ul className="flex flex-col divide-y divide-border" data-testid="statement-months">
        {state.data.items.map((item) => (
          <li key={item.month}>
            <Link
              href={`/merchant/statements/${item.month}`}
              prefetch={false}
              className="flex min-h-14 items-center justify-between gap-3 px-4 hover:bg-muted sm:px-6"
            >
              <span className="flex items-center gap-2 font-medium">
                {monthLabel(item.month)}
                {item.current && <Badge tone="outline">{tm('statements.current')}</Badge>}
              </span>
              <span className="text-sm text-primary">{tm('statements.open')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * A month's statement (S21 ST2, ST3): the document as printed, "طباعة / حفظ PDF" on the A4 print
 * page and "تنزيل Excel". A month outside the account answers `STATEMENT_MONTH_INVALID`.
 */
export function StatementPage() {
  const { month } = useParams<{ month: string }>();
  // A month outside the account is a page of its own, not a failed read.
  const read = useCallback(async (): Promise<Result<Statement | null>> => {
    const result = await getStatement(month);
    if (!result.ok && result.reason === 'STATEMENT_MONTH_INVALID') return { ok: true, data: null };
    return result;
  }, [month]);
  const { state, reload } = useMerchantRead(read);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton rows={4} />}
      />
    );
  }
  const statement = state.data;
  if (statement === null) return <InvalidMonth />;

  async function download(statement: Statement) {
    setFailure(null);
    setBusy(true);
    const result = await exportStatement(statement.month);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    saveBlob(result.blob, result.fileName);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="xl"
          render={<Link href="/merchant/statements" prefetch={false} />}
        >
          {tm('statements.back')}
        </Button>
        <Button
          size="xl"
          render={<Link href={`/merchant/statements/${month}/print`} prefetch={false} />}
        >
          <PrinterIcon aria-hidden="true" />
          {tm('statements.print')}
        </Button>
        <Button
          variant="outline"
          size="xl"
          disabled={busy}
          onClick={() => void download(statement)}
        >
          <FileSpreadsheetIcon aria-hidden="true" />
          {tm('statements.excel')}
        </Button>
      </div>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <div className="rounded-lg border border-border bg-white p-4 sm:p-6">
        <StatementDocument statement={statement} />
      </div>
    </div>
  );
}

/** A month outside the account (`STATEMENT_MONTH_INVALID`), the month page and its print. */
export function InvalidMonth() {
  return (
    <EmptyState
      icon={<CalendarX2Icon />}
      title={tm('statements.invalid')}
      action={
        <Button
          variant="outline"
          size="xl"
          render={<Link href="/merchant/statements" prefetch={false} />}
        >
          {tm('statements.back')}
        </Button>
      }
    />
  );
}
