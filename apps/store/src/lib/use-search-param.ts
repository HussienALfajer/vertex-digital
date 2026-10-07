'use client';

import { useEffect, useState } from 'react';

/**
 * One query parameter of the current URL, read after hydration. Pages stay static: no
 * `useSearchParams`, which would need a Suspense boundary and render the form on the client only.
 */
export function useSearchParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(name));
  }, [name]);
  return value;
}
