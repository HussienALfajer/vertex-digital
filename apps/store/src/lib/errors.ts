import ar from '../messages/ar.json';
import type { Failure } from './api';
import { type MessageKey, t } from './i18n';

type Explained = keyof typeof ar.errors;

/**
 * The message for a failed request: `errors.<code>` when the store explains that code, else the
 * generic one. Never the server's own text.
 */
export function errorText(reason: Failure): string {
  const key: Explained = reason in ar.errors ? (reason as Explained) : 'UNKNOWN';
  return t(`errors.${key}` as MessageKey);
}
