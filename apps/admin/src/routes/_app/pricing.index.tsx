import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';

/** The retail list's page holds the rules this address once showed; old links still land there. */
export const Route = createFileRoute('/_app/pricing/')({
  beforeLoad: () => {
    throw redirect({
      to: '/pricing/lists/$id',
      params: { id: ROOT_PRICE_LIST_IDS.retail },
      replace: true,
    });
  },
});
