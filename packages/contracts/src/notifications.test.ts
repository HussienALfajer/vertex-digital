import { describe, expect, it } from 'vitest';
import { QUEUES } from './jobs.js';
import {
  CODE_EMAIL_TEMPLATES,
  EMAIL_PARAMS,
  EMAIL_TEMPLATES,
  isCodeEmail,
} from './notifications.js';

describe('email templates', () => {
  it('each have their parameters', () => {
    expect(Object.keys(EMAIL_PARAMS).sort()).toEqual([...EMAIL_TEMPLATES].sort());
  });

  it('tell code emails apart (rule E2)', () => {
    for (const template of EMAIL_TEMPLATES) {
      const code = (CODE_EMAIL_TEMPLATES as readonly string[]).includes(template);
      expect(isCodeEmail(template), template).toBe(code);
      if (code) expect(EMAIL_PARAMS[template].safeParse({ code: '123456' }).success).toBe(true);
    }
  });

  it('are sent through queues named <area>.<action>', () => {
    for (const queue of Object.values(QUEUES)) expect(queue).toMatch(/^[a-z]+\.[a-z-]+$/);
  });
});
