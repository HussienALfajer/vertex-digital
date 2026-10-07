/** A form-level error, announced to screen readers. */
export function FormAlert({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-status-danger px-3 py-2 text-sm text-status-danger-foreground"
    >
      {children}
    </p>
  );
}
