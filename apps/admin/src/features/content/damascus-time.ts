/*
 * Banner and announcement schedules are entered and shown in `Asia/Damascus` (S14 BN4), whatever
 * the viewer's own zone: a `datetime-local` field holds Damascus wall-clock time.
 */

const wallClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant as a `datetime-local` value in Damascus: `2026-10-11T18:30`. */
export function toDamascusInput(iso: string): string {
  const parts = Object.fromEntries(
    wallClock.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const shown = new Intl.DateTimeFormat('ar-u-nu-latn', {
  timeZone: 'Asia/Damascus',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A schedule's time as the panel shows it, in Damascus with Latin digits. */
export const formatDamascus = (iso: string) => shown.format(new Date(iso));

const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A `datetime-local` value read as Damascus time, as an ISO instant; null when malformed. */
export function fromDamascusInput(value: string): string | null {
  const match = INPUT.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset at that moment, measured by reading the guess back in Damascus.
  const offset = Date.parse(`${toDamascusInput(new Date(asUtc).toISOString())}:00Z`) - asUtc;
  return new Date(asUtc - offset).toISOString();
}
