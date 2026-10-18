import { useQuery } from '@tanstack/react-query';
import {
  expectedDeliveryMinutesSchema,
  ORDER_POLICY_DEFAULTS,
  routeHardLimitMinutesSchema,
  routeTimingValid,
} from '@vertex-digital/contracts';
import { Field, FieldDescription, FieldError, FieldLabel, Input, Switch } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { orderPolicyQuery } from '../orders/orders.queries';

/** A route's S17 settings: whether it counts for the price, and its timing. */
export interface RouteSettings {
  priceBasis: boolean;
  expectedDeliveryMinutes: number | null;
  hardLimitMinutes: number | null;
}

/** The settings as the form holds them: the minutes as typed. */
export interface RouteSettingsDraft {
  priceBasis: boolean;
  expected: string;
  limit: string;
}

export type RouteSettingsField = 'expected' | 'limit';

export const settingsDraft = (settings: RouteSettings): RouteSettingsDraft => ({
  priceBasis: settings.priceBasis,
  expected: settings.expectedDeliveryMinutes?.toString() ?? '',
  limit: settings.hardLimitMinutes?.toString() ?? '',
});

const minutes = (text: string) => (text.trim() === '' ? null : Number(text.trim()));

/**
 * The draft as the API takes it, or the refused fields: whole minutes within their bounds, the
 * expected time below the route's limit, or the policy's when it has none (`ROUTE_TIMING_INVALID`).
 */
export function parseSettings(
  draft: RouteSettingsDraft,
  policyLimitMinutes: number,
): { settings: RouteSettings } | { invalid: RouteSettingsField[] } {
  const expected = minutes(draft.expected);
  const limit = minutes(draft.limit);
  const invalid: RouteSettingsField[] = [];
  if (expected !== null && !expectedDeliveryMinutesSchema.safeParse(expected).success) {
    invalid.push('expected');
  }
  if (limit !== null && !routeHardLimitMinutesSchema.safeParse(limit).success) {
    invalid.push('limit');
  }
  const timing = { expectedDeliveryMinutes: expected, hardLimitMinutes: limit };
  if (invalid.length === 0 && !routeTimingValid(timing, policyLimitMinutes)) {
    invalid.push('expected');
  }
  if (invalid.length > 0) return { invalid };
  return { settings: { priceBasis: draft.priceBasis, ...timing } };
}

/** The order policy's hard limit, the default a route without its own limit takes (WR9). */
export function usePolicyLimit(): number {
  const policy = useQuery(orderPolicyQuery);
  return policy.data?.hardLimitMinutes ?? ORDER_POLICY_DEFAULTS.hardLimitMinutes;
}

/** S17 "Screens": the price-basis switch, the expected delivery time and the review limit. */
export function RouteSettingsFields({
  id,
  draft,
  invalid,
  policyLimitMinutes,
  onChange,
}: {
  id: string;
  draft: RouteSettingsDraft;
  invalid: RouteSettingsField[];
  policyLimitMinutes: number;
  onChange: (draft: RouteSettingsDraft) => void;
}) {
  const { t } = useTranslation();
  const expectedInvalid = invalid.includes('expected');
  const limitInvalid = invalid.includes('limit');
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <span className="flex items-center gap-2 text-sm">
          <Switch
            id={`price-basis-${id}`}
            checked={draft.priceBasis}
            onCheckedChange={(priceBasis) => onChange({ ...draft, priceBasis })}
          />
          <label htmlFor={`price-basis-${id}`} className="font-medium">
            {t('suppliers.routes.settings.priceBasis')}
          </label>
        </span>
        <FieldDescription>{t('suppliers.routes.settings.priceBasisHelp')}</FieldDescription>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field invalid={expectedInvalid}>
          <FieldLabel>{t('suppliers.routes.settings.expected')}</FieldLabel>
          <Input
            name={`expected-${id}`}
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            value={draft.expected}
            onChange={(event) => onChange({ ...draft, expected: event.target.value })}
          />
          <FieldError match={expectedInvalid}>
            {t('suppliers.routes.settings.expectedError')}
          </FieldError>
        </Field>
        <Field invalid={limitInvalid}>
          <FieldLabel>
            {t('suppliers.routes.settings.limit', { policy: policyLimitMinutes })}
          </FieldLabel>
          <Input
            name={`limit-${id}`}
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            placeholder={String(policyLimitMinutes)}
            value={draft.limit}
            onChange={(event) => onChange({ ...draft, limit: event.target.value })}
          />
          <FieldError match={limitInvalid}>{t('suppliers.routes.settings.limitError')}</FieldError>
        </Field>
      </div>
    </div>
  );
}
