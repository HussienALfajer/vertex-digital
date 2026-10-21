import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { SearchXIcon } from 'lucide-react';
import { tm } from '@/features/merchant-tools/i18n';

/** S21 VF3: one neutral page for any unknown verification code. */
export default function VerificationNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-10 md:py-16">
      <EmptyState
        icon={<SearchXIcon />}
        title={tm('verify.notFound')}
        description={tm('verify.notFoundBody')}
      />
    </div>
  );
}
