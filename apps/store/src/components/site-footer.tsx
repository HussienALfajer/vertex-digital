import { t } from '@/lib/i18n';

export async function SiteFooter() {
  'use cache';
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">
        <span dir="ltr">{t('footer.rights', { year: new Date().getFullYear() })}</span>
      </div>
    </footer>
  );
}
