import { adminClientErrorSchema } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { clientErrorReport } from './report-error';

describe('clientErrorReport (audit A10-26)', () => {
  it('sends the error and the page, never its query', () => {
    const report = clientErrorReport(new TypeError('x is undefined'), '/customers?q=layla');
    expect(report).toMatchObject({
      name: 'TypeError',
      message: 'x is undefined',
      path: '/customers',
    });
    expect(adminClientErrorSchema.parse(report)).toEqual(report);
  });

  it('turns a thrown value that is not an Error into one the API takes', () => {
    const report = clientErrorReport('boom', '/');
    expect(adminClientErrorSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ name: 'Error', message: 'boom', path: '/' });
  });
});
