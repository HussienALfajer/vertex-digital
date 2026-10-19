import { Link } from '@tanstack/react-router';
import {
  isInternalCheck,
  type OpenMismatch,
  type ReconciliationResult,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { formatDateTime, formatSince } from '../../lib/format';
import { shortId } from '../audit/audit-labels';
import {
  money,
  offendingTarget,
  RESULT_TONES,
  resultStatusLabel,
  subjectLabel,
} from './reconciliation-labels';

/** An amount of a result in its currency, or a dash. */
function Amount({ result, units }: { result: ReconciliationResult; units: number | null }) {
  const { t } = useTranslation();
  if (units === null) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{money(t, result.currency ?? 'USD', units)}</span>;
}

/** The allowed range of an external check (rules E2–E4), or a dash for exact checks. */
function Range({ result }: { result: ReconciliationResult }) {
  const { t } = useTranslation();
  const { allowedLowUnits: low, allowedHighUnits: high, currency } = result;
  if (low === null || high === null) return <span className="text-muted-foreground">—</span>;
  const unit = currency ?? 'USD';
  return (
    <span className="tabular-nums">
      {low === high
        ? money(t, unit, low)
        : t('reconciliation.range', { low: money(t, unit, low), high: money(t, unit, high) })}
    </span>
  );
}

/** S18 RC2: the attempts a supplier charged differently, and its orders no attempt names. */
function ChargeFindings({ result }: { result: ReconciliationResult }) {
  const { t } = useTranslation();
  const lines = result.details.lines.filter((line) => CHARGE_LINE_KINDS.has(line.kind));
  const unmatched = result.details.unmatchedSupplierOrders;
  if (lines.length === 0 && unmatched.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1">
          {lines.map((line) => (
            <li key={`${line.kind}:${line.id}`} className="flex flex-wrap items-center gap-2">
              <span>{t(`reconciliation.lineKinds.${line.kind as ChargeLineKind}`)}</span>
              <span className="tabular-nums">{money(t, 'USD', line.amountUnits)}</span>
              <bdi className="text-muted-foreground">{shortId(line.id)}</bdi>
              <CopyButton value={line.id} label={t('audit.copyId', { id: line.id })} />
            </li>
          ))}
        </ul>
      )}
      {unmatched.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {t('reconciliation.unmatchedSupplierOrders', { count: unmatched.length })}
          </p>
          <ul className="flex flex-wrap gap-2">
            {unmatched.map((id) => (
              <li key={id}>
                <bdi dir="ltr" className="tabular-nums">
                  {id}
                </bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const CHARGE_LINE_KINDS = new Set([
  'charge_differs',
  'delivered_but_failed',
  'failed_but_delivered',
]);

type ChargeLineKind = 'charge_differs' | 'delivered_but_failed' | 'failed_but_delivered';

/** The ids a check found, each linked to its page where it has one (S13 screens). */
export function OffendingIds({ result }: { result: ReconciliationResult }) {
  const { t } = useTranslation();
  const { offending } = result.details;
  if (offending.length === 0) return <ChargeFindings result={result} />;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">
        {t('reconciliation.offending', { count: result.offendingCount })}
      </p>
      <ul className="flex flex-wrap gap-2 text-sm">
        {offending.map(({ kind, id }) => {
          const target = offendingTarget(kind, id);
          const label = `${t(`reconciliation.offendingKinds.${kind}`)} ${shortId(id)}`;
          return (
            <li key={`${kind}:${id}`} className="flex items-center gap-1">
              {target ? (
                <Link
                  {...(target as { to: '/orders/$id'; params: { id: string } })}
                  className="underline-offset-4 hover:underline"
                >
                  <bdi>{label}</bdi>
                </Link>
              ) : (
                <bdi>{label}</bdi>
              )}
              <CopyButton value={id} label={t('audit.copyId', { id })} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "حالات مفتوحة" (rule RN7): each open mismatch with its check, subject, books, actual, range,
 * difference, when it was first seen and its ids. Internal checks come first, in the danger
 * color, as a fault in the books that needs a technical review.
 */
export function OpenMismatchList({
  mismatches,
  onExplain,
}: {
  mismatches: OpenMismatch[];
  onExplain: (result: OpenMismatch) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-3">
      {mismatches.map((result) => {
        const internal = isInternalCheck(result.check);
        return (
          <li
            key={result.id}
            className={
              internal
                ? 'flex flex-col gap-3 rounded-lg border border-destructive-text bg-surface p-4'
                : 'flex flex-col gap-3 rounded-lg border border-border bg-surface p-4'
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">
                  {t(`reconciliation.checks.${result.check}`)} ·{' '}
                  <bdi>{subjectLabel(t, result.subject)}</bdi>
                </p>
                {internal && (
                  <p className="text-sm font-medium text-destructive-text">
                    {t('reconciliation.internalFault')}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  {t('reconciliation.firstSeen', { since: formatSince(result.firstSeenAt) })}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onExplain(result)}>
                {t('reconciliation.explain.open')}
              </Button>
            </div>
            {/* Exact ledger checks carry ids, not amounts. */}
            {(result.booksUnits !== null || result.actualUnits !== null) && (
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Fact label={t('reconciliation.columns.books')}>
                  <Amount result={result} units={result.booksUnits} />
                </Fact>
                <Fact label={t('reconciliation.columns.actual')}>
                  <Amount result={result} units={result.actualUnits} />
                </Fact>
                <Fact label={t('reconciliation.columns.range')}>
                  <Range result={result} />
                </Fact>
                <Fact label={t('reconciliation.columns.difference')}>
                  <Amount result={result} units={result.differenceUnits} />
                </Fact>
              </dl>
            )}
            <OffendingIds result={result} />
          </li>
        );
      })}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/** A run's page: every check with its result (S13 screens "السجل"). */
export function ResultsTable({ results }: { results: ReconciliationResult[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('reconciliation.columns.check')}</TableHead>
          <TableHead>{t('reconciliation.columns.subject')}</TableHead>
          <TableHead>{t('reconciliation.columns.result')}</TableHead>
          <TableHead>{t('reconciliation.columns.books')}</TableHead>
          <TableHead>{t('reconciliation.columns.actual')}</TableHead>
          <TableHead>{t('reconciliation.columns.range')}</TableHead>
          <TableHead>{t('reconciliation.columns.difference')}</TableHead>
          <TableHead>{t('reconciliation.columns.explanation')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map((result) => (
          <TableRow key={result.id} className="align-top">
            <TableCell className="whitespace-normal">
              <div className="flex flex-col gap-2 py-1">
                {t(`reconciliation.checks.${result.check}`)}
                <OffendingIds result={result} />
              </div>
            </TableCell>
            <TableCell>
              <bdi>{subjectLabel(t, result.subject)}</bdi>
            </TableCell>
            <TableCell>
              <Badge tone={RESULT_TONES[result.status]}>{resultStatusLabel(t, result)}</Badge>
            </TableCell>
            <TableCell>
              <Amount result={result} units={result.booksUnits} />
            </TableCell>
            <TableCell>
              <Amount result={result} units={result.actualUnits} />
            </TableCell>
            <TableCell>
              <Range result={result} />
            </TableCell>
            <TableCell>
              <Amount result={result} units={result.differenceUnits} />
            </TableCell>
            <TableCell className="whitespace-normal">
              {result.explanation ? (
                <span className="flex flex-col gap-0.5 text-sm">
                  <span>{result.explanation.note}</span>
                  <span className="text-muted-foreground">
                    {result.explanation.adminName ?? t('common.unknown')} ·{' '}
                    {formatDateTime(result.explanation.createdAt)}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
