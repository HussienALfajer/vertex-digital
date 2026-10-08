import type { RoutingContext } from '@vertex-digital/db';
import type { Env } from './env.js';

/** What routing reads from the running app (S07 rule SP1): the time and the adapters it has. */
export function routingContext(env: Pick<Env, 'SUPPLIER_FAKE_ENABLED'>): RoutingContext {
  return { now: new Date(), fakeEnabled: env.SUPPLIER_FAKE_ENABLED };
}
