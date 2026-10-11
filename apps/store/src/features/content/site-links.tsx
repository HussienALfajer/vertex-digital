import type { ContentPage, SiteContent } from '@vertex-digital/contracts';
import { Callout } from '@vertex-digital/ui/components/callout';
import { MessageCircleQuestionIcon } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { siteContent } from './data';

/*
 * The links to published content (S14 SL1, SL3, TA1): each shows only once its page or the FAQ is
 * published, and nothing shows when the read failed.
 */

const published = (site: SiteContent | null, page: ContentPage) =>
  site?.pages.some((entry) => entry.page === page) ?? false;

const FOOTER_PAGES = ['terms', 'privacy', 'refund', 'about'] as const satisfies ContentPage[];

/** SL1: beside "الدعم" and the Telegram link. */
export async function FooterContentLinks({ className }: { className: string }) {
  const site = await siteContent();
  return (
    <>
      {site?.faqPublished && (
        <Link href="/faq" prefetch={false} className={className}>
          {t('footer.faq')}
        </Link>
      )}
      {FOOTER_PAGES.filter((page) => published(site, page)).map((page) => (
        <Link key={page} href={`/${page}`} prefetch={false} className={className}>
          {t(`footer.${page}`)}
        </Link>
      ))}
    </>
  );
}

/** TA1: under the sign-up form, naming only the published pages; nothing with neither. */
export async function TermsAgreement() {
  const site = await siteContent();
  const links = (['terms', 'privacy'] as const)
    .filter((page) => published(site, page))
    .map((page) => (
      <Link
        key={page}
        href={`/${page}`}
        prefetch={false}
        className="font-medium text-foreground underline underline-offset-4"
      >
        {t(`signUp.agreement.${page}`)}
      </Link>
    ));
  if (links.length === 0) return null;
  return (
    <p data-testid="terms-agreement" className="text-center text-sm text-muted-foreground">
      {t('signUp.agreement.prefix')} {links[0]}
      {links[1] && (
        <>
          {' '}
          {t('signUp.agreement.and')}
          {links[1]}
        </>
      )}
    </p>
  );
}

/** SL3: "قبل أن تكتب لنا: اقرأ الأسئلة الشائعة" on the support pages, while the FAQ is published. */
export async function FaqCallout() {
  const site = await siteContent();
  if (!site?.faqPublished) return null;
  return (
    <Callout
      tone="info"
      icon={<MessageCircleQuestionIcon />}
      title={t('support.faqCallout.title')}
      description={
        <Link href="/faq" prefetch={false} className="font-medium underline underline-offset-4">
          {t('support.faqCallout.link')}
        </Link>
      }
    />
  );
}
