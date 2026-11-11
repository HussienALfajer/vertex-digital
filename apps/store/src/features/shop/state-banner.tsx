import type { ShopPublic } from '@vertex-digital/contracts';
import { Callout } from '@vertex-digital/ui/components/callout';
import { ts } from './i18n';

/**
 * SH6, SH7: a suspended shop says so with the reason's category (never the admin's note) and
 * sells nothing; a closed shop takes no new customers but sells to balances it holds.
 */
export function ShopStateBanner({ shop }: { shop: ShopPublic }) {
  if (shop.status === 'suspended') {
    return (
      <Callout tone="warning" title={ts('status.suspended')}>
        {ts(`status.suspendedReasons.${shop.suspendReason ?? 'other'}`)}
      </Callout>
    );
  }
  if (shop.status === 'closed') {
    return (
      <Callout tone="info" title={ts('status.closed')}>
        {ts('status.closedBody')}
      </Callout>
    );
  }
  return null;
}
