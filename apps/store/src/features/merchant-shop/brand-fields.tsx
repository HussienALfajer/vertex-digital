'use client';

import { SHOP_BRAND_COLORS } from '@vertex-digital/contracts';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { CheckIcon, CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { type ShopAreaMessageKey, tsa } from './i18n';
import { colorVerdict, normalizeColor } from './rules';

const VERDICT_TEXT: Record<ReturnType<typeof colorVerdict>, ShopAreaMessageKey> = {
  ok: 'request.colorOk',
  invalid: 'request.colorInvalid',
  white_text: 'request.colorWhiteText',
  dark_theme: 'request.colorDarkTheme',
};

/**
 * ST1: the 12 ready colors as swatches and a hex field for any other, with the contrast verdict
 * under it. `typed` is the field as written; the swatch matching it is the chosen one.
 */
export function BrandFields({
  typed,
  onChange,
  showError,
}: {
  typed: string;
  onChange: (typed: string) => void;
  showError: boolean;
}) {
  const verdict = colorVerdict(typed);
  const chosen = normalizeColor(typed);
  const refused = verdict !== 'ok';
  return (
    <Field invalid={showError && refused}>
      <FieldLabel render={<span />}>{tsa('request.color')}</FieldLabel>
      <FieldDescription>{tsa('request.colorHint')}</FieldDescription>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{tsa('request.color')}</legend>
        {SHOP_BRAND_COLORS.map((color) => {
          const selected = chosen === color;
          return (
            <label
              key={color}
              className="flex size-11 cursor-pointer items-center justify-center rounded-full border-2 border-transparent text-white has-checked:border-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
              // The swatch is the color itself: the one place a shop color is drawn as a fill.
              style={{ backgroundColor: color }}
            >
              <input
                type="radio"
                name="brandSwatch"
                value={color}
                checked={selected}
                aria-label={tsa('request.swatch', { color })}
                onChange={() => onChange(color)}
                className="sr-only"
              />
              {selected && <CheckIcon className="size-5" aria-hidden="true" />}
            </label>
          );
        })}
      </fieldset>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="size-11 shrink-0 rounded-md border border-border"
          style={chosen ? { backgroundColor: chosen } : undefined}
        />
        <Input
          name="brandColor"
          dir="ltr"
          aria-label={tsa('request.colorHex')}
          placeholder={SHOP_BRAND_COLORS[0]}
          className="h-11 max-w-40 text-md"
          value={typed}
          aria-invalid={showError && refused}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {verdict === 'ok' ? (
        <p className="flex items-center gap-2 text-sm text-status-success-foreground">
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          {tsa(VERDICT_TEXT.ok)}
        </p>
      ) : showError || verdict !== 'invalid' ? (
        <FieldError match>
          <span className="flex items-center gap-2">
            <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            {tsa(VERDICT_TEXT[verdict])}
          </span>
        </FieldError>
      ) : null}
    </Field>
  );
}
