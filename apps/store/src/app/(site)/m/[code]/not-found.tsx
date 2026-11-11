import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { SearchXIcon } from 'lucide-react';
import { tm } from '@/features/merchant-tools/i18n';

/** S23 ID7: one neutral page for any unknown certificate code (as VF3). */
export default function CertificateNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-10 md:py-16">
      <EmptyState
        icon={<SearchXIcon />}
        title={tm('tier.public.notFound')}
        description={tm('tier.public.notFoundHint')}
      />
    </div>
  );
}
