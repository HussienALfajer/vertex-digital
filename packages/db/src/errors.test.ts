import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { withoutQueryParameters } from './errors.js';

describe('withoutQueryParameters', () => {
  it('keeps the parameters of a failed query out of the error', async () => {
    const { db, close } = createDatabase(process.env.DATABASE_URL as string);
    try {
      const failed = await db
        .execute(sql`select * from no_such_table where code = ${'482913'}`)
        .catch((error: unknown) => error);
      expect(String((failed as Error).message)).toContain('482913');
      const reported = withoutQueryParameters(failed) as Error & { code: string };
      expect(reported.message).not.toContain('482913');
      expect(reported.code).toBe('42P01');
    } finally {
      await close();
    }
  });

  it('drops the values PostgreSQL puts in `detail`', () => {
    const cause = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      detail: 'Key (email)=(a@example.com) already exists.',
    });
    const wrapped = Object.assign(new Error('Failed query: insert … params: a@example.com'), {
      query: 'insert …',
      params: ['a@example.com'],
      cause,
    });
    const reported = withoutQueryParameters(wrapped) as Error & { code: string; detail?: string };
    expect(reported).toMatchObject({ message: 'duplicate key value', code: '23505' });
    expect(reported.detail).toBeUndefined();
  });

  it('leaves other errors alone', () => {
    const error = new Error('plain');
    expect(withoutQueryParameters(error)).toBe(error);
    expect(withoutQueryParameters('text')).toBe('text');
    const bare = Object.assign(new Error('x'), { query: 'q', params: [] });
    expect((withoutQueryParameters(bare) as Error).message).toBe('Database query failed');
  });
});
