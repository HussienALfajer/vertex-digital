const TONES = {
  danger: 'bg-status-danger text-status-danger-foreground',
  success: 'bg-status-success text-status-success-foreground',
} as const;

/**
 * A form-level message, announced to screen readers: an error with its next step, or the
 * confirmation that something worked.
 */
export function FormAlert({
  tone = 'danger',
  children,
}: {
  tone?: keyof typeof TONES;
  children: string;
}) {
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-md px-4 py-3 text-sm ${TONES[tone]}`}
    >
      {children}
    </p>
  );
}
