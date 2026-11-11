import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { ts } from './i18n';

/** A shop's 404 (S26 screens): the store's look, without a link to the store. */
export function ShopNotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState titleAs="h1" title={ts('notFound.title')} description={ts('notFound.body')} />
    </div>
  );
}
