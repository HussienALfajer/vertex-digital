import { useQuery } from '@tanstack/react-query';
import {
  type AdminMerchantTier,
  LEVEL_TIERS,
  type LevelTier,
  REVIEW_TIME_ZONE,
  TIER_GRANT_MAX_DAYS,
  type TierGrant,
  tierGrantEndInputSchema,
  tierGrantEndsAt,
  tierGrantInputSchema,
  tierRank,
} from '@vertex-digital/contracts';
import {
  Button,
  Dialog,
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
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { AwardIcon, CircleStopIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { Picker } from '../pricing/picker';
import { merchantTiersQuery, useEndTierGrant, useGrantTier } from './merchants.queries';
import { TierChip } from './tier-chip';

/** A grant ends at the start of the Damascus day after `endsOn`: the panel shows `endsOn`. */
const lastDay = (endsAt: string) => formatDate(new Date(Date.parse(endsAt) - 60_000).toISOString());

/** The Damascus calendar day `days` after today, `YYYY-MM-DD`. */
function damascusDayAfter(days: number, now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: REVIEW_TIME_ZONE }).format(now);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * S23 AD5 on the customer profile: the effective and earned tiers, where the tier comes from (MG2:
 * "ممنوحة يدوياً حتى <date>"), since when, "منح فئة" (MG1) and "إنهاء المنح" (MG3), and the
 * grant history. A revoked merchant shows the history only.
 */
export function MerchantTierCard({
  customerId,
  name,
  revoked,
  tier,
}: {
  customerId: string;
  name: string;
  revoked: boolean;
  tier: AdminMerchantTier;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<'grant' | 'end' | null>(null);
  const open = tier.openGrant;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('merchants.tiers.profile.title')}</h4>
        {!revoked && (
          <fieldset aria-label={t('merchants.tiers.profile.title')} className="flex gap-2">
            {open ? (
              <Button variant="outline" size="sm" onClick={() => setDialog('end')}>
                <CircleStopIcon />
                {t('merchants.tiers.grant.end')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setDialog('grant')}>
                <AwardIcon />
                {t('merchants.tiers.grant.action')}
              </Button>
            )}
          </fieldset>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-4">
        <Fact label={t('merchants.tiers.profile.effective')}>
          <TierChip tier={tier.tier} granted={tier.source === 'granted'} />
        </Fact>
        <Fact label={t('merchants.tiers.profile.earned')}>
          <TierChip tier={tier.earnedTier} />
        </Fact>
        <Fact label={t('merchants.tiers.profile.source')}>
          {tier.source === 'granted' && open
            ? t('merchants.tiers.profile.grantedUntil', { date: lastDay(open.endsAt) })
            : t('merchants.tiers.profile.earnedSource')}
        </Fact>
        <Fact label={t('merchants.tiers.profile.since')}>
          {tier.since ? formatDate(tier.since) : '—'}
        </Fact>
      </dl>
      {open && tier.source !== 'granted' && (
        // MG6: the earned tier reached the grant's; the grant runs on without effect.
        <p className="text-sm text-muted-foreground">
          {t('merchants.tiers.profile.grantIdle', {
            tier: t(`merchants.tierNames.${open.tier}`),
            date: lastDay(open.endsAt),
          })}
        </p>
      )}
      {tier.grants.length > 0 && <GrantHistory grants={tier.grants} />}
      <Dialog open={dialog !== null} onOpenChange={(next) => !next && setDialog(null)}>
        {dialog === 'grant' && (
          <GrantTierDialog
            customerId={customerId}
            name={name}
            earnedTier={tier.earnedTier}
            onDone={() => setDialog(null)}
          />
        )}
        {dialog === 'end' && open && (
          <EndGrantDialog
            customerId={customerId}
            grant={open}
            earnedTier={tier.earnedTier}
            onDone={() => setDialog(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/** The grants, newest first: tier, period, state, and the reason under them. */
function GrantHistory({ grants }: { grants: TierGrant[] }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h5 className="text-sm text-muted-foreground">{t('merchants.tiers.grant.history')}</h5>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {grants.map((grant) => (
          <li key={grant.id} className="flex flex-col gap-1 p-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <TierChip tier={grant.tier} />
              <span className="tabular-nums">
                {formatDate(grant.startsAt)} – {lastDay(grant.endsAt)}
              </span>
              <span className="text-muted-foreground">
                {grant.endReason
                  ? t('merchants.tiers.grant.ended', {
                      reason: t(`merchants.tiers.grant.endReasons.${grant.endReason}`),
                      date: formatDate(grant.endedAt ?? grant.endsAt),
                    })
                  : t('merchants.tiers.grant.running')}
              </span>
            </span>
            <span className="break-words">{grant.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type GrantField = 'tier' | 'endsOn' | 'reason';

/**
 * MG1: a tier above the earned one with a live level, until a Damascus day 1 to 90 days away, with a
 * reason; re-authenticated. The merchant sees it like an earned tier, with no mark of a grant.
 */
function GrantTierDialog({
  customerId,
  name,
  earnedTier,
  onDone,
}: {
  customerId: string;
  name: string;
  earnedTier: AdminMerchantTier['earnedTier'];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const grant = useGrantTier(customerId);
  const tiers = useQuery(merchantTiersQuery);
  const live = new Set(
    (tiers.data?.items ?? []).flatMap((view) => (view.level ? [view.tier] : [])),
  );
  const items = LEVEL_TIERS.filter(
    (tier) => live.has(tier) && tierRank(tier) > tierRank(earnedTier),
  ).map((tier) => ({ value: tier, label: t(`merchants.tierNames.${tier}`) }));
  const [tier, setTier] = useState<LevelTier | null>(null);
  const [endsOn, setEndsOn] = useState(() => damascusDayAfter(30));
  const [invalid, setInvalid] = useState<Set<GrantField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = tierGrantInputSchema.safeParse({
      tier: tier ?? undefined,
      endsOn,
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    const refused = new Set<GrantField>(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0] as GrantField),
    );
    if (parsed.success && tierGrantEndsAt(parsed.data.endsOn, new Date()) === null) {
      refused.add('endsOn');
    }
    if (!parsed.success || refused.size > 0) {
      setInvalid(refused);
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await grant.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.tiers.grant.title', { name })}</DialogTitle>
        <DialogDescription>{t('merchants.tiers.grant.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('tier')}>
          <FieldLabel render={<span />}>{t('merchants.tiers.grant.tier')}</FieldLabel>
          <Picker
            label={t('merchants.tiers.grant.tier')}
            placeholder={t('merchants.fields.choose')}
            items={items}
            value={tier}
            onChange={(value) => setTier(value as LevelTier)}
            read={tiers}
          />
          <FieldDescription>
            {items.length === 0 && tiers.isSuccess
              ? t('merchants.tiers.grant.noTier')
              : t('merchants.tiers.grant.tierHint', {
                  tier: t(`merchants.tierNames.${earnedTier}`),
                })}
          </FieldDescription>
          <FieldError match={invalid.has('tier')}>
            {t('merchants.tiers.grant.tierError')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('endsOn')}>
          <FieldLabel>{t('merchants.tiers.grant.endsOn')}</FieldLabel>
          <Input
            name="endsOn"
            type="date"
            dir="ltr"
            min={damascusDayAfter(1)}
            max={damascusDayAfter(TIER_GRANT_MAX_DAYS)}
            value={endsOn}
            onChange={(event) => setEndsOn(event.target.value)}
          />
          <FieldDescription>{t('merchants.tiers.grant.endsOnHint')}</FieldDescription>
          <FieldError match={invalid.has('endsOn')}>
            {t('merchants.tiers.grant.endsOnError', { max: TIER_GRANT_MAX_DAYS })}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('reason')}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid.has('reason')}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <InvalidAlert show={invalid.size > 0} />
          <Button type="submit" disabled={grant.isPending || !tiers.isSuccess}>
            {t('merchants.tiers.grant.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** MG3: ends the open grant now, with a reason; the merchant returns to the earned tier. */
function EndGrantDialog({
  customerId,
  grant,
  earnedTier,
  onDone,
}: {
  customerId: string;
  grant: TierGrant;
  earnedTier: AdminMerchantTier['earnedTier'];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const end = useEndTierGrant(customerId);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = tierGrantEndInputSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    try {
      await end.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('merchants.tiers.grant.endTitle')}</DialogTitle>
        <DialogDescription>
          {t('merchants.tiers.grant.endDescription', {
            tier: t(`merchants.tierNames.${grant.tier}`),
            date: lastDay(grant.endsAt),
            earned: t(`merchants.tierNames.${earnedTier}`),
          })}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('merchants.fields.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('merchants.validation.reason')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={end.isPending}>
            {t('merchants.tiers.grant.endSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
