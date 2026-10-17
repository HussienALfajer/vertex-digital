import { describe, expect, it } from 'vitest';
import { ApiError, call } from './client';

const failed = (status: number, error: unknown) =>
  call(Promise.resolve({ error, response: new Response(null, { status }) }));

describe('call', () => {
  it("keeps the API's own code", async () => {
    await expect(failed(413, { code: 'PAYLOAD_TOO_LARGE', message: 'x' })).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    await expect(failed(409, { code: 'NAME_TAKEN', message: 'x' })).rejects.toMatchObject({
      code: 'NAME_TAKEN',
    });
  });

  it("reads nginx's 413 page as the size limit (F7-3)", async () => {
    const error = await failed(413, '<html><body>413 Request Entity Too Large</body></html>').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).knownCode).toBe('PAYLOAD_TOO_LARGE');
  });

  it('leaves another status without a code unknown', async () => {
    const error = await failed(502, '<html>Bad Gateway</html>').catch((e: unknown) => e);
    expect((error as ApiError).code).toBeUndefined();
  });
});
