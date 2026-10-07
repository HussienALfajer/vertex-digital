import { AscentLines } from '@vertex-digital/ui/brand/ascent-lines';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { t } from '@/lib/i18n';

export default function HomePage() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <AscentLines className="absolute inset-y-0 end-0 h-full w-1/3 text-accent opacity-10" />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-4 py-16 md:py-24">
        <h1 className="flex max-w-2xl items-start gap-3 text-3xl font-bold md:text-4xl">
          <AscentBar className="mt-2 h-8 w-1.5" />
          {t('home.title')}
        </h1>
        <p className="max-w-2xl text-md text-muted-foreground">{t('home.subtitle')}</p>
        <p className="max-w-2xl text-base text-accent-text">{t('home.soon')}</p>
      </div>
    </section>
  );
}
