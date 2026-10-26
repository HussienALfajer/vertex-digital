import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* Leaving the signed-in state (rule D4, sign-out; audit A01-25). */

let auth: typeof import('./auth');

beforeAll(async () => {
  // The auth client reads the panel's origin when it loads.
  vi.stubGlobal('window', { location: { origin: 'https://digital-admin.vertexmedia.pro' } });
  auth = await import('./auth');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('leaveSession', () => {
  it('drops cached answers and every mutation input and result, keeping the session as null', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['account', 'sessions'], [{ id: 's' }]);
    // A finished mutation keeps what was typed (a password) and what came back (codes).
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: async (password: string) => [password, 'abcde-fghjk'] })
      .execute('typed-password');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    const navigate = vi.fn(async () => {});
    await auth.leaveSession(queryClient, navigate);

    expect(navigate).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(auth.sessionQuery.queryKey)).toBeNull();
    expect(queryClient.getQueryData(['account', 'sessions'])).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });
});
