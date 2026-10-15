import { t } from '@/lib/i18n';
import { FormAlert } from './form-alert';

/**
 * Beside the submit button while fields are refused, so the reason shows at once even when the
 * first refused field is out of view (`useFocusInvalid` has moved the focus there). Its own file,
 * so pages that only show a `FormAlert` (the game page) do not ship it.
 */
export function InvalidAlert({ show }: { show: boolean }) {
  return show ? <FormAlert>{t('forms.invalid')}</FormAlert> : null;
}
