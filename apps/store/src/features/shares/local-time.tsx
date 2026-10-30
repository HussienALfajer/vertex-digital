'use client';

import { useEffect, useState } from 'react';
import { formatDate, formatDateTime } from '@/lib/format';

/** A time in the viewer's zone: written after hydration, never by the server (lib/format.ts). */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => setText(formatDateTime(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

/** A date in the viewer's zone, written after hydration (S23 ID7: the certificate's "منذ"). */
export function LocalDate({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => setText(formatDate(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}
