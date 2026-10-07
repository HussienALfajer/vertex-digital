import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** Data table. Figures use tabular numerals; icons inside cells default to 16 px (§3, §7). */
function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto rounded-lg border border-border bg-surface"
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom text-sm tabular-nums [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('bg-muted [&_tr]:border-b [&_tr]:border-border', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border transition-colors duration-150 hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-3 text-start align-middle font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

type SortDirection = 'asc' | 'desc';

type TableSortHeadProps = ComponentProps<'th'> & {
  /** The column's direction, or null while the table is sorted by another column. */
  direction: SortDirection | null;
  onSort: () => void;
};

/** A column header that sorts the table by its column; `aria-sort` names the current order. */
function TableSortHead({ direction, onSort, children, className, ...props }: TableSortHeadProps) {
  const Icon =
    direction === 'asc' ? ArrowUpIcon : direction === 'desc' ? ArrowDownIcon : ChevronsUpDownIcon;
  return (
    <th
      data-slot="table-head"
      aria-sort={
        direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined
      }
      className={cn(
        'h-10 px-3 text-start align-middle font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    >
      <button
        type="button"
        onClick={onSort}
        data-slot="table-sort"
        className={cn(
          '-mx-2 inline-flex h-8 items-center gap-1 rounded-md px-2 transition-colors duration-150 ease-out',
          'hover:bg-surface hover:text-foreground',
          direction && 'text-foreground',
        )}
      >
        {children}
        <Icon aria-hidden="true" className={cn('size-3.5', !direction && 'opacity-50')} />
      </button>
    </th>
  );
}

function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('h-11 px-3 align-middle whitespace-nowrap', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('py-3 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  type SortDirection,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
};
