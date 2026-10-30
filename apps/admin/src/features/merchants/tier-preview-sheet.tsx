import {
  formatAmountInput,
  LEVEL_TIERS,
  type LevelTier,
  type MerchantTierView,
  parseUsd,
  type TierPreview,
  tierPreviewInputSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useTierPreview } from './merchants.queries';
import { TierChip } from './tier-chip';

/**
 * S23 AD3: proposed thresholds for Silver, Gold and Diamond (empty: no level) against today: per
 * tier the merchants who would hold it (LV3, the larger of the previous and this month), and who
 * would rise or fall, at most 50 names each. Reads only; nothing is saved.
 */
export function TierPreviewSheet({
  open,
  tiers,
  onClose,
}: {
  open: boolean;
  tiers: MerchantTierView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-[min(32rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
        {open && <PreviewForm tiers={tiers} />}
        <Button variant="outline" className="mt-6" onClick={onClose}>
          {t('common.close')}
        </Button>
      </SheetContent>
    </Sheet>
  );
}

function PreviewForm({ tiers }: { tiers: MerchantTierView[] }) {
  const { t } = useTranslation();
  const preview = useTierPreview();
  const [values, setValues] = useState<Record<LevelTier, string>>(() => {
    const threshold = (tier: LevelTier) => {
      const level = tiers.find((view) => view.tier === tier)?.level;
      return level ? formatAmountInput('USD', level.monthlyThresholdUsdUnits) : '';
    };
    return { silver: threshold('silver'), gold: threshold('gold'), diamond: threshold('diamond') };
  });
  const [invalid, setInvalid] = useState<Set<LevelTier>>(new Set());
  const [order, setOrder] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const input = Object.fromEntries(
      LEVEL_TIERS.map((tier) => {
        const text = values[tier].trim();
        return [tier, text === '' ? null : (parseUsd(text) ?? Number.NaN)];
      }),
    );
    const parsed = tierPreviewInputSchema.safeParse(input);
    if (!parsed.success) {
      const fields = parsed.error.issues.flatMap((issue) =>
        LEVEL_TIERS.filter((tier) => tier === issue.path[0]),
      );
      setInvalid(new Set(fields));
      setOrder(fields.length === 0);
      return focusInvalid();
    }
    setInvalid(new Set());
    setOrder(false);
    try {
      await preview.mutateAsync(parsed.data);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SheetTitle className="text-xl font-bold">{t('merchants.tiers.preview.title')}</SheetTitle>
        <p className="text-sm text-muted-foreground">{t('merchants.tiers.preview.description')}</p>
      </div>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {LEVEL_TIERS.map((tier) => (
          <Field key={tier} invalid={invalid.has(tier)}>
            <FieldLabel>
              {t('merchants.tiers.preview.threshold', { tier: t(`merchants.tierNames.${tier}`) })}
            </FieldLabel>
            <Input
              name={tier}
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              placeholder={t('merchants.tiers.preview.none')}
              value={values[tier]}
              onChange={(event) => {
                const value = event.target.value;
                setValues((current) => ({ ...current, [tier]: value }));
              }}
            />
            <FieldError match={invalid.has(tier)}>
              {t('merchants.tiers.level.thresholdError')}
            </FieldError>
          </Field>
        ))}
        <p className="text-sm text-muted-foreground">{t('merchants.tiers.preview.hint')}</p>
        {order && <FormAlert>{t('merchants.tiers.preview.order')}</FormAlert>}
        {failure && <FormAlert>{failure}</FormAlert>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={preview.isPending}>
            {t('merchants.tiers.preview.submit')}
          </Button>
          <InvalidAlert show={invalid.size > 0} />
        </div>
      </form>
      {preview.data && <PreviewResult result={preview.data} />}
    </div>
  );
}

function PreviewResult({ result }: { result: TierPreview }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <h3 className="font-medium">{t('merchants.tiers.preview.result')}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('merchants.columns.tier')}</TableHead>
            <TableHead>{t('merchants.tiers.preview.now')}</TableHead>
            <TableHead>{t('merchants.tiers.preview.proposed')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.tiers.map((row) => (
            <TableRow key={row.tier}>
              <TableCell>
                <TierChip tier={row.tier} />
              </TableCell>
              <TableCell className="tabular-nums">{row.now}</TableCell>
              <TableCell className="font-medium tabular-nums">{row.proposed}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Movers
        title={t('merchants.tiers.preview.rising', { count: result.risingTotal })}
        icon={<ArrowUpIcon className="size-4 text-status-success-foreground" aria-hidden="true" />}
        movers={result.rising}
        total={result.risingTotal}
      />
      <Movers
        title={t('merchants.tiers.preview.falling', { count: result.fallingTotal })}
        icon={<ArrowDownIcon className="size-4 text-status-danger-foreground" aria-hidden="true" />}
        movers={result.falling}
        total={result.fallingTotal}
      />
    </section>
  );
}

function Movers({
  title,
  icon,
  movers,
  total,
}: {
  title: string;
  icon: ReactNode;
  movers: TierPreview['rising'];
  total: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h4>
      {movers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('merchants.tiers.preview.noMovers')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {movers.map((mover) => (
            <li key={mover.customerId} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{mover.tradeName}</span>
              <TierChip tier={mover.from} />
              <span aria-hidden="true">←</span>
              <span className="sr-only">{t('merchants.tiers.preview.to')}</span>
              <TierChip tier={mover.to} />
            </li>
          ))}
        </ul>
      )}
      {total > movers.length && (
        <p className="text-xs text-muted-foreground">
          {t('merchants.tiers.preview.more', { count: total - movers.length })}
        </p>
      )}
    </div>
  );
}
