import {
  type MarginRuleValues,
  type MarginScope,
  marginRuleValuesSchema,
  parseUsd,
  setMarginRuleSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { PricePreview } from './price-preview';
import { useSetRule } from './pricing.queries';
import { parseCostUsd, parsePercentBp, ruleTexts } from './pricing-format';

/** The cost the live preview starts with (S06 screens). */
const SAMPLE_COST = '1.00';

type RuleField = 'percent' | 'fixed' | 'minimum';

/** The rule's values from the form's text, or null for each value that is not valid (rule PR1). */
function valuesOf(texts: Record<RuleField, string>): MarginRuleValues | null {
  const parsed = marginRuleValuesSchema.safeParse({
    percentBp: parsePercentBp(texts.percent),
    fixedUsdUnits: parseUsd(texts.fixed),
    minMarginUsdUnits: parseUsd(texts.minimum),
  });
  return parsed.success ? parsed.data : null;
}

/** The form's fields that are not valid. */
function invalidFields(texts: Record<RuleField, string>): RuleField[] {
  const shape = marginRuleValuesSchema.shape;
  const invalid: RuleField[] = [];
  if (!shape.percentBp.safeParse(parsePercentBp(texts.percent)).success) invalid.push('percent');
  if (!shape.fixedUsdUnits.safeParse(parseUsd(texts.fixed)).success) invalid.push('fixed');
  if (!shape.minMarginUsdUnits.safeParse(parseUsd(texts.minimum)).success) {
    invalid.push('minimum');
  }
  return invalid;
}

/**
 * The rule form (rule PR9): percent, fixed amount and minimum margin, with a live preview for a
 * sample cost (rule PR10). Saving opens re-authentication when the API asks for it.
 */
export function RuleDialog({
  scope,
  targetId,
  targetName,
  initial,
  onDone,
}: {
  scope: MarginScope;
  targetId: string | null;
  /** The category, game or product's name; null for the global rule. */
  targetName: string | null;
  /** The rule in force: the target's own, or the one it inherits. */
  initial: MarginRuleValues;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const setRule = useSetRule();
  const [texts, setTexts] = useState(() => ruleTexts(initial));
  const [costText, setCostText] = useState(SAMPLE_COST);
  const [errors, setErrors] = useState<RuleField[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const values = valuesOf(texts);
  const cost = parseCostUsd(costText);
  const request =
    values && cost ? { target: { scope, targetId }, costUsdUnits: cost, values } : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const invalid = invalidFields(texts);
    setErrors(invalid);
    const parsed = setMarginRuleSchema.safeParse({ ...values, scope, targetId });
    if (invalid.length > 0 || !parsed.success) return;
    try {
      await setRule.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const field = (name: RuleField, hint: string) => (
    <Field invalid={errors.includes(name)}>
      <FieldLabel>{t(`pricing.form.${name}`)}</FieldLabel>
      <Input
        name={name}
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        value={texts[name]}
        onChange={(event) => setTexts((previous) => ({ ...previous, [name]: event.target.value }))}
      />
      <FieldDescription>{hint}</FieldDescription>
      <FieldError match={errors.includes(name)}>{t(`pricing.form.errors.${name}`)}</FieldError>
    </Field>
  );

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {targetName
            ? t('pricing.form.titleFor', { scope: t(`pricing.scopes.${scope}`), name: targetName })
            : t('pricing.form.titleGlobal')}
        </DialogTitle>
        <DialogDescription>{t('pricing.form.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-3">
          {field('percent', t('pricing.form.percentHint'))}
          {field('fixed', t('pricing.form.fixedHint'))}
          {field('minimum', t('pricing.form.minimumHint'))}
        </div>
        <section
          className="flex flex-col gap-3 rounded-lg bg-muted p-4"
          aria-labelledby="rule-preview"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 id="rule-preview" className="text-base font-bold">
              {t('pricing.form.preview')}
            </h3>
            <Field invalid={cost === null} className="w-40">
              <FieldLabel>{t('pricing.form.sampleCost')}</FieldLabel>
              <Input
                name="sampleCost"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                value={costText}
                onChange={(event) => setCostText(event.target.value)}
              />
            </Field>
          </div>
          <PricePreview request={request} />
        </section>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={setRule.isPending}>
            {setRule.isPending ? t('pricing.form.saving') : t('pricing.form.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
