import { Link, type LinkProps, useRouterState } from '@tanstack/react-router';
import { PageHeader, Tabs, TabsList, TabsTrigger } from '@vertex-digital/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const TABS = [
  { to: '/content/pages', key: 'pages' },
  { to: '/content/faq', key: 'faq' },
  { to: '/content/banners', key: 'banners' },
  { to: '/content/announcements', key: 'announcements' },
  { to: '/content/activity', key: 'activity' },
] as const satisfies readonly { to: LinkProps['to']; key: string }[];

/** "المحتوى" (S14 screens): one tab per part, each its own route. */
export function ContentLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = TABS.find((tab) => pathname.startsWith(tab.to))?.key ?? 'pages';
  return (
    <>
      <PageHeader title={t('content.title')} description={t('content.subtitle')} />
      <Tabs value={current}>
        <TabsList aria-label={t('content.title')}>
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              nativeButton={false}
              render={<Link to={tab.to} />}
            >
              {t(`content.tabs.${tab.key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </>
  );
}
