import {
  type SortDirection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
} from '@vertex-digital/ui';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * A report's table (S13 screens): sorted by column on the client, with a totals row computed by
 * the server below the rows, never sorted with them.
 */

export interface Column<Row> {
  id: string;
  label: string;
  cell: (row: Row) => ReactNode;
  /** The value the column sorts by; a column without one does not sort. */
  sort?: (row: Row) => number | string;
  /** The column's cell in the totals row. */
  total?: ReactNode;
  numeric?: boolean;
}

const compare = (a: number | string, b: number | string) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ar');

export function ReportTable<Row>({
  rows,
  columns,
  rowKey,
  label,
  totals = true,
}: {
  rows: Row[];
  columns: Column<Row>[];
  rowKey: (row: Row) => string;
  /** The table's name for screen readers. */
  label: string;
  /** Show the totals row (the cells each column gives). */
  totals?: boolean;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ id: string; direction: SortDirection } | null>(null);
  const sortColumn = columns.find((column) => column.id === sort?.id);
  const sorted =
    sort && sortColumn?.sort
      ? [...rows].sort((a, b) => {
          const order = compare(
            (sortColumn.sort as (row: Row) => number | string)(a),
            (sortColumn.sort as (row: Row) => number | string)(b),
          );
          return sort.direction === 'asc' ? order : -order;
        })
      : rows;

  function toggle(id: string) {
    setSort((current) =>
      current?.id !== id
        ? { id, direction: 'desc' }
        : current.direction === 'desc'
          ? { id, direction: 'asc' }
          : null,
    );
  }

  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          {columns.map((column) =>
            column.sort ? (
              <TableSortHead
                key={column.id}
                direction={sort?.id === column.id ? sort.direction : null}
                onSort={() => toggle(column.id)}
              >
                {column.label}
              </TableSortHead>
            ) : (
              <TableHead key={column.id}>{column.label}</TableHead>
            ),
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TableRow key={rowKey(row)}>
            {columns.map((column) => (
              <TableCell key={column.id} className={column.numeric ? 'tabular-nums' : undefined}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {totals && (
          <TableRow className="bg-surface font-bold">
            {columns.map((column, index) => (
              <TableCell key={column.id} className={column.numeric ? 'tabular-nums' : undefined}>
                {index === 0 ? t('reports.totals') : (column.total ?? '')}
              </TableCell>
            ))}
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
