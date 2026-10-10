'use client';

import { useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/format';

/** A time in the viewer's zone: written after hydration, never by the server (lib/format.ts). */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => setText(formatDateTime(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}
