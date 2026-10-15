import type { Dispatch, FormEvent, SetStateAction } from 'react';

/**
 * A form's `onInput`: the error of the field being edited goes away at once, so a corrected field
 * no longer shows the message of the last submit (2026-10-15 system test: the sign-up form kept
 * "enter your name" under a name already typed). The field is found by its `name`.
 */
export function clearErrorOnInput<Errors extends Partial<Record<string, string>>>(
  setErrors: Dispatch<SetStateAction<Errors>>,
) {
  return (event: FormEvent<HTMLFormElement>) => {
    const name = (event.target as HTMLInputElement | null)?.name;
    if (!name) return;
    setErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));
  };
}
