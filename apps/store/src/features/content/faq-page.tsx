import { parseRichText } from '@vertex-digital/contracts';
import { RichText } from '@vertex-digital/ui/components/rich-text';
import { ChevronDownIcon } from 'lucide-react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { t } from '@/lib/i18n';
import { getPublishedFaq } from './data';
import { updatedText } from './texts';

/**
 * A stable fragment (S14 FQ7): the random tail of the id, so the admin can link to one question.
 * The head of a UUIDv7 is its creation time, shared by rows made in the same minute.
 */
export const faqFragment = (prefix: 'q' | 's', id: string) => `${prefix}-${id.slice(-8)}`;

/**
 * `/faq` (S14 FQ5, FQ7): the published snapshot with jump chips per section, each question a
 * native `<details>` with its answer through `RichText`; no client JavaScript. Not found while
 * unpublished or empty.
 */
export async function FaqView() {
  await connection();
  const faq = await getPublishedFaq();
  if (!faq || faq.sections.length === 0) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 md:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{t('content.faq.title')}</h1>
        <p className="text-sm text-muted-foreground">{updatedText(faq.updatedAt)}</p>
      </header>
      {faq.sections.length > 1 && (
        <nav aria-label={t('content.faq.sections')}>
          <ul className="flex flex-wrap gap-2">
            {faq.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${faqFragment('s', section.id)}`}
                  className="inline-flex h-11 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-muted"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {faq.sections.map((section) => (
        <section
          key={section.id}
          id={faqFragment('s', section.id)}
          className="flex scroll-mt-4 flex-col gap-3"
        >
          <h2 className="text-xl font-bold">{section.title}</h2>
          {section.items.map((item) => (
            <details
              key={item.id}
              id={faqFragment('q', item.id)}
              className="group scroll-mt-4 rounded-lg border border-border bg-surface"
            >
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
                {item.question}
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="px-4 pb-4">
                <RichText blocks={parseRichText(item.answer).blocks} />
              </div>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
