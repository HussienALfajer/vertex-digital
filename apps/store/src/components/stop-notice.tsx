import { TriangleAlertIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/** The stop banner's text (S05 rule SW9), loaded only while something is stopped. */
export function StopNotice({ stopped }: { stopped: 'purchases' | 'deposits' | 'both' }) {
  return (
    <div role="status" className="bg-status-warning text-status-warning-foreground">
      <div className="mx-auto flex max-w-6xl items-start gap-2 px-4 py-3 text-sm sm:items-center">
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 sm:mt-0" />
        <p>{t(`stopBanner.${stopped}`)}</p>
      </div>
    </div>
  );
}
