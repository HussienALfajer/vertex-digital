import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

interface PaginationProps extends Omit<ComponentProps<'nav'>, 'onChange'> {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** e.g. "21–40 of 57", formatted by the app. */
  summary?: ReactNode;
  previousLabel: string;
  nextLabel: string;
}

/**
 * A summary with previous and next page buttons (hidden when everything fits on one page); the
 * arrows point along the reading direction.
 */
function Pagination({
  page,
  pageCount,
  onPageChange,
  summary,
  previousLabel,
  nextLabel,
  className,
  ...props
}: PaginationProps) {
  return (
    <nav
      data-slot="pagination"
      className={cn('flex flex-wrap items-center justify-between gap-4', className)}
      {...props}
    >
      <p className="text-sm text-muted-foreground tabular-nums">{summary}</p>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronRightIcon className="ltr:-scale-x-100" />
            {previousLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            {nextLabel}
            <ChevronLeftIcon className="ltr:-scale-x-100" />
          </Button>
        </div>
      )}
    </nav>
  );
}

export { Pagination, type PaginationProps };
