import { clearStoredCart } from '@/features/cart/cart-keys';
import { forgetSession } from '@/lib/session';

/**
 * What this browser forgets once its session has ended, whichever button ended it (the header's
 * sign-out, "this device" or "every device" on the account page; audit A01-6): the push
 * subscription (PS5, so the next person to sign in here is not subscribed without asking), the
 * cart (S10 rule CT1) and the signed-in and private-prices hints. Light enough for the header: the
 * push code is its own chunk, fetched only here.
 */
export async function forgetThisBrowser(): Promise<void> {
  await import('@/features/push/device').then((device) => device.forgetDevice()).catch(() => {});
  clearStoredCart();
  forgetSession();
}
