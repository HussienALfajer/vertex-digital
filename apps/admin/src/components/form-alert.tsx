import { useTranslation } from 'react-i18next';

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

/**
 * Beside the submit button while fields are refused, so the reason shows at once even when the
 * first refused field is far up the page (`useFocusInvalid` has moved the focus there).
 */
export function InvalidAlert({ show }: { show: boolean }) {
  const { t } = useTranslation();
  return show ? <FormAlert>{t('common.invalidFields')}</FormAlert> : null;
}
