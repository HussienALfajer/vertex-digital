import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PageSummary } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { PencilIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { pagesQuery } from './content.queries';

/** "الصفحات" (S14 PG1): the four fixed pages, their state and whether the draft is ahead. */
export function PagesPage() {
  const { t } = useTranslation();
  const pages = useQuery(pagesQuery);

  if (pages.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (pages.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, pages.error)}</FormAlert>
        <Button variant="outline" onClick={() => pages.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('content.pages.page')}</TableHead>
          <TableHead>{t('content.pages.state')}</TableHead>
          <TableHead>
            <span className="sr-only">{t('content.actions.edit')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pages.data.map((page) => (
          <PageRow key={page.page} page={page} />
        ))}
      </TableBody>
    </Table>
  );
}

function PageRow({ page }: { page: PageSummary }) {
  const { t } = useTranslation();
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{page.title}</span>
        <span className="block text-sm text-muted-foreground" dir="ltr">
          /{page.page}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {page.latestVersion ? (
            <span>
              {t('content.pages.published', {
                version: page.latestVersion.version,
                date: formatDate(page.latestVersion.publishedAt),
              })}
            </span>
          ) : (
            <Badge tone="neutral">{t('content.pages.unpublished')}</Badge>
          )}
          {page.unpublishedChanges && (
            <Badge tone="warning">{t('content.unpublishedChanges')}</Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-end">
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/content/pages/$page" params={{ page: page.page }} />}
        >
          <PencilIcon />
          {t('content.actions.edit')}
        </Button>
      </TableCell>
    </TableRow>
  );
}
