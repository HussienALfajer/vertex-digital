import {
  formatUsd,
  type MarginRule,
  type MarginRuleValues,
  type MarginScope,
} from '@vertex-digital/contracts';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { ltr } from '../../lib/format';
import { useArchiveRule } from './pricing.queries';
import { formatPercentBp } from './pricing-format';

/*
 * What the pricing page and a game's pricing tab share: the rule form's target, a rule's values,
 * and the archive confirmation.
 */

/** The rule form's target: what it sets and the values it starts from. */
export interface RuleTarget {
  scope: MarginScope;
  targetId: string | null;
  targetName: string | null;
  initial: MarginRuleValues;
}

/** A rule's three values (rule PR1). */
export function RuleFacts({ rule }: { rule: MarginRuleValues }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-3 gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">{t('pricing.form.percent')}</dt>
        <dd className="text-lg font-bold tabular-nums">
          <bdi dir="ltr">{formatPercentBp(rule.percentBp)}%</bdi>
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">{t('pricing.form.fixed')}</dt>
        <dd className="text-lg font-bold tabular-nums">
          <bdi dir="ltr">{formatUsd(rule.fixedUsdUnits)}</bdi>
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">{t('pricing.form.minimum')}</dt>
        <dd className="text-lg font-bold tabular-nums">
          <bdi dir="ltr">{formatUsd(rule.minMarginUsdUnits)}</bdi>
        </dd>
      </div>
    </dl>
  );
}

/** A rule's values on one line, for tables: `10% + $0.00 · ≥ $0.10`. */
export function RuleLine({ rule }: { rule: MarginRuleValues }) {
  const { t } = useTranslation();
  return (
    <span className="tabular-nums">
      {t('pricing.line', {
        percent: ltr(`${formatPercentBp(rule.percentBp)}%`),
        fixed: ltr(formatUsd(rule.fixedUsdUnits)),
        minimum: ltr(formatUsd(rule.minMarginUsdUnits)),
      })}
    </span>
  );
}

/** Archive a rule: its target falls back to the parent rule (rule PR2). */
export function ArchiveRuleDialog({
  rule,
  onClose,
}: {
  rule: MarginRule | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const archive = useArchiveRule();
  return (
    <ConfirmDialog
      open={!!rule}
      onClose={onClose}
      title={t('pricing.archive.title')}
      body={t('pricing.archive.body', {
        target: rule?.targetName ?? '',
        parent: rule ? t(`pricing.archive.parents.${rule.scope}`) : '',
      })}
      action={t('pricing.archive.action')}
      destructive
      pending={archive.isPending}
      onConfirm={async () => {
        if (rule) await archive.mutateAsync(rule.id);
      }}
    />
  );
}
