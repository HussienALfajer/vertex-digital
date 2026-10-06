import { v7 as uuidv7 } from 'uuid';

/** New primary key: a time-ordered UUIDv7 generated in the application (ADR 0011). */
export function newId(): string {
  return uuidv7();
}
