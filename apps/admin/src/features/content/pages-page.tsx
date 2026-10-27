import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { contentPagePath, type PageSummary } from '@vertex-digital/contracts';
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
import { ReadFailure } from '../../components/read-failure';
import { useVisibleAgain } from '../../lib/admin-stream';
import { formatDate } from '../../lib/format';
import { pagesQuery } from './content.queries';
import { StaleRead } from './content-parts';

/** "الصفحات" (S14 PG1): the four fixed pages, their state and whether the draft is ahead. */
export function PagesPage() {
  const { t } = useTranslation();
  const pages = useQuery(pagesQuery);
  useVisibleAgain(() => void pages.refetch());

  if (pages.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (!pages.data) return <ReadFailure error={pages.error} onRetry={() => pages.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      {pages.isError && <StaleRead onRetry={() => pages.refetch()} />}
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
    </div>
  );
}

function PageRow({ page }: { page: PageSummary }) {
  const { t } = useTranslation();
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{page.title}</span>
        <span className="block text-sm text-muted-foreground" dir="ltr">
          {contentPagePath(page.page)}
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
          className="h-11"
          aria-label={t('content.actions.editNamed', { name: page.title })}
          render={<Link to="/content/pages/$page" params={{ page: page.page }} />}
        >
          <PencilIcon />
          {t('content.actions.edit')}
        </Button>
      </TableCell>
    </TableRow>
  );
}
