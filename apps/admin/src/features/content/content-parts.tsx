import { useQuery } from '@tanstack/react-query';
import {
  type ContentState,
  parseRichText,
  RICH_TEXT_PROBLEMS,
  type RichTextProblem,
  type RichTextProblemReason,
} from '@vertex-digital/contracts';
import { Badge, cn, RichText, ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { ltr } from '../../lib/format';
import { faqQuery, pagesQuery } from './content.queries';
import { formatDamascus } from './damascus-time';
import { linkTargets, unpublishedTargets } from './rich-links';

/*
 * What the content screens share: the state badge (BN4), the schedule, the store-styled preview
 * frame (PG4), the Markdown problems by line (MD2) and the fields a refusal names.
 */

const STATE_TONES = {
  disabled: 'neutral',
  scheduled: 'info',
  live: 'success',
  ended: 'warning',
  archived: 'neutral',
} as const satisfies Record<ContentState, string>;

export function StateBadge({ state }: { state: ContentState }) {
  const { t } = useTranslation();
  return <Badge tone={STATE_TONES[state]}>{t(`content.states.${state}`)}</Badge>;
}

/** "من … إلى …" in Damascus time (BN4), or "بلا جدول". */
export function ScheduleText({
  startsAt,
  endsAt,
}: {
  startsAt: string | null;
  endsAt: string | null;
}) {
  const { t } = useTranslation();
  if (startsAt && endsAt) {
    return t('content.schedule.between', {
      start: formatDamascus(startsAt),
      end: formatDamascus(endsAt),
    });
  }
  if (startsAt) return t('content.schedule.from', { start: formatDamascus(startsAt) });
  if (endsAt) return t('content.schedule.until', { end: formatDamascus(endsAt) });
  return t('content.schedule.always');
}

type PreviewWidth = 'phone' | 'desktop';

/**
 * Rule PG4: content as the store shows it, dark (the store's default) at phone or desktop width.
 * The frame redefines the theme tokens through the `dark` class, so the panel's theme does not
 * leak in.
 */
export function StorePreview({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState<PreviewWidth>('phone');
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('content.preview.label')}</p>
        <ToggleGroup<PreviewWidth>
          aria-label={t('content.preview.widths')}
          value={[width]}
          onValueChange={(value) => value[0] && setWidth(value[0])}
        >
          <ToggleGroupItem value="phone">{t('content.preview.phone')}</ToggleGroupItem>
          <ToggleGroupItem value="desktop">{t('content.preview.desktop')}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-muted p-3">
        <div
          data-testid="store-preview"
          className={cn(
            'dark mx-auto overflow-hidden rounded-md bg-background text-foreground',
            width === 'phone' ? 'w-[375px] max-w-full' : 'w-full min-w-[640px]',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A page body or an FAQ answer through the store's renderer (MD5). */
export function RichPreview({ source }: { source: string }) {
  return <RichText blocks={parseRichText(source).blocks} />;
}

/** The store paths that answer today: the published pages, and `/faq` once it holds a question. */
function usePublishedPaths(): ReadonlySet<string> | null {
  const pages = useQuery(pagesQuery);
  const faq = useQuery(faqQuery(false));
  if (!pages.data || !faq.data) return null;
  // A page's path is its name with hyphens (S20: `merchant_terms` is `/merchant-terms`).
  const paths = pages.data
    .filter((page) => page.latestVersion)
    .map((page) => `/${page.page.replaceAll('_', '-')}`);
  if ((faq.data.publication?.items ?? 0) > 0) paths.push('/faq');
  return new Set(paths);
}

/** Edge case 20: a link to a page or the FAQ before it is published shows a 404 in the store. */
export function LinkWarnings({ source }: { source: string }) {
  const { t } = useTranslation();
  const published = usePublishedPaths();
  if (!published) return null;
  const targets = unpublishedTargets(linkTargets(parseRichText(source).blocks), published);
  if (targets.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-sm text-status-warning-foreground">
      {targets.map((target) => (
        <li key={target}>{t('content.problems.unpublishedLink', { path: ltr(target) })}</li>
      ))}
    </ul>
  );
}

/** Rule MD2: each problem next to its line, with how to fix it. */
export function ProblemList({ problems }: { problems: RichTextProblem[] }) {
  const { t } = useTranslation();
  if (problems.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 text-sm text-destructive-text">
      <p className="font-medium">{t('content.problems.title', { count: problems.length })}</p>
      <ul className="flex flex-col gap-0.5">
        {problems.map((problem) => (
          <li key={`${problem.line}-${problem.reason}`}>
            {t('content.problems.line', {
              line: problem.line,
              reason: t(`content.problems.reasons.${problem.reason}`),
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

const REASONS = new Set<string>(RICH_TEXT_PROBLEMS);

/** The MD2 problems of a refused save or publish (`details` at `[field, line]`). */
export function refusedProblems(error: unknown, field: string): RichTextProblem[] {
  return refusedIssues(error)
    .filter(
      (issue) =>
        issue.path[0] === field && typeof issue.path[1] === 'number' && REASONS.has(issue.message),
    )
    .map((issue) => ({
      line: issue.path[1] as number,
      reason: issue.message as RichTextProblemReason,
    }));
}

/** The fields a `VALIDATION_FAILED` names (`details` as the API's validation pipe writes them). */
export function refusedFields(error: unknown): Set<string> {
  return new Set(refusedIssues(error).map((issue) => String(issue.path[0])));
}

function refusedIssues(error: unknown): { path: unknown[]; message: string }[] {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return [];
  return Array.isArray(error.details)
    ? (error.details as { path?: unknown[]; message?: unknown }[]).map((issue) => ({
        path: Array.isArray(issue.path) ? issue.path : [],
        message: String(issue.message ?? ''),
      }))
    : [];
}
