import { EmptyState, PageHeader } from '@vertex-digital/ui';
import { LayoutDashboardIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../lib/auth';

/** The panel's start page; each feature adds its own section to the navigation. */
export function HomePage() {
  const { t } = useTranslation();
  const { user } = useSession();
  return (
    <>
      <PageHeader title={t('home.title', { name: user.name })} description={t('home.subtitle')} />
      <EmptyState
        icon={<LayoutDashboardIcon />}
        title={t('home.emptyTitle')}
        description={t('home.emptyBody')}
      />
    </>
  );
}
