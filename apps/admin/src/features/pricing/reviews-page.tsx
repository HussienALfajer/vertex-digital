import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type DecideReviews,
  type DecideReviewsResult,
  formatUsd,
  PRICE_REVIEW_STATUSES,
  type PriceReview,
  SUPPLIER_CODES,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  PageHeader,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ScaleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatSince, ltr } from '../../lib/format';
import { AvailabilityBadge } from '../catalog/catalog-parts';
import {
  previewQuery,
  REVIEWS_PAGE_SIZE,
  reviewsQuery,
  useAdjustMargin,
  useDecideReviews,
} from './pricing.queries';
import { formatCostUsd, formatPercentBp } from './pricing-format';
import type { ReviewSearch } from './review-search';
import { RuleDialog } from './rule-dialog';

const ALL = 'all';

/** What happened to a review the admin decided, shown on its row after the list reads again. */
type Outcome = DecideReviewsResult['results'][number];

/**
 * "/pricing/reviews" (S07 screens): cost changes above the threshold that hold a price (rules
 * P2–P4): cost before → after, price now → proposed, the margins; accept one or several, adjust
 * the margin (re-authentication), or pause. `REVIEW_STALE` reads the row again with its new
 * figures. Filters by status and supplier in the URL.
 */
export function ReviewsPage({
  search,
  onSearch,
}: {
  search: ReviewSearch;
  onSearch: (next: ReviewSearch) => void;
}) {
  const { t } = useTranslation();
  const reviews = useQuery(reviewsQuery(search));
  const decide = useDecideReviews();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Map<string, Outcome>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const [pausing, setPausing] = useState<PriceReview | null>(null);
  const [adjusting, setAdjusting] = useState<PriceReview | null>(null);
  const open = (search.status ?? 'open') === 'open';
  const items = reviews.data?.items ?? [];
  const page = search.page ?? 1;
  const pageCount = Math.max(1, Math.ceil((reviews.data?.total ?? 0) / REVIEWS_PAGE_SIZE));

  async function run(decisions: DecideReviews['decisions']) {
    setFailure(null);
    try {
      const { results } = await decide.mutateAsync({ decisions });
      setOutcomes(new Map(results.map((result) => [result.reviewId, result])));
      setSelected((previous) => {
        const next = new Set(previous);
        for (const result of results) if (result.result !== 'refused') next.delete(result.reviewId);
        return next;
      });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const accept = (rows: PriceReview[]) =>
    run(
      rows.map((review) => ({
        reviewId: review.id,
        action: 'accept' as const,
        expectedPriceUsdUnits: review.proposedPriceUsdUnits,
      })),
    );

  const statusItems = PRICE_REVIEW_STATUSES.map((value) => ({
    value,
    label: t(`pricing.reviews.statuses.${value}`),
  }));
  const supplierItems = [
    { value: ALL, label: t('pricing.reviews.allSuppliers') },
    ...SUPPLIER_CODES.map((value) => ({ value, label: t(`suppliers.names.${value}`) })),
  ];

  return (
    <>
      <PageHeader title={t('pricing.reviews.title')} description={t('pricing.reviews.subtitle')} />
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-full sm:w-48">
          <FieldLabel>{t('pricing.reviews.status')}</FieldLabel>
          <Select
            items={statusItems}
            value={search.status ?? 'open'}
            onValueChange={(value) => {
              setSelected(new Set());
              setOutcomes(new Map());
              onSearch({
                ...search,
                status: value && value !== 'open' ? (value as ReviewSearch['status']) : undefined,
                page: undefined,
              });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-full sm:w-48">
          <FieldLabel>{t('pricing.reviews.supplier')}</FieldLabel>
          <Select
            items={supplierItems}
            value={search.supplier ?? ALL}
            onValueChange={(value) =>
              onSearch({
                ...search,
                supplier: value && value !== ALL ? (value as ReviewSearch['supplier']) : undefined,
                page: undefined,
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {supplierItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {open && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
          <span className="text-sm font-medium tabular-nums">
            {t('pricing.reviews.selected', { count: selected.size })}
          </span>
          <Button
            disabled={decide.isPending}
            onClick={() => accept(items.filter((review) => selected.has(review.id)))}
          >
            {t('pricing.reviews.acceptSelected')}
          </Button>
        </div>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      {reviews.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {reviews.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, reviews.error)}</FormAlert>
          <Button variant="outline" onClick={() => reviews.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {reviews.isSuccess &&
        (items.length === 0 ? (
          <EmptyState
            icon={<ScaleIcon />}
            title={open ? t('pricing.reviews.empty') : t('pricing.reviews.emptyClosed')}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {open && (
                    <TableHead>
                      <Checkbox
                        aria-label={t('pricing.reviews.selectAll')}
                        checked={items.every((review) => selected.has(review.id))}
                        onCheckedChange={(on) =>
                          setSelected(on ? new Set(items.map((review) => review.id)) : new Set())
                        }
                      />
                    </TableHead>
                  )}
                  <TableHead>{t('pricing.reviews.columns.product')}</TableHead>
                  <TableHead>{t('pricing.reviews.columns.supplier')}</TableHead>
                  <TableHead>{t('pricing.reviews.columns.cost')}</TableHead>
                  <TableHead>{t('pricing.reviews.columns.price')}</TableHead>
                  <TableHead>{t('pricing.reviews.columns.margin')}</TableHead>
                  <TableHead>{t('pricing.reviews.columns.availability')}</TableHead>
                  {open && (
                    <TableHead>
                      <span className="sr-only">{t('pricing.reviews.columns.actions')}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((review) => (
                  <TableRow key={review.id}>
                    {open && (
                      <TableCell>
                        <Checkbox
                          aria-label={t('pricing.reviews.select', { name: review.productNameAr })}
                          checked={selected.has(review.id)}
                          onCheckedChange={(on) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (on) next.add(review.id);
                              else next.delete(review.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <Link
                          to="/catalog/games/$id"
                          params={{ id: review.gameId }}
                          search={{ tab: 'products' }}
                          className="font-medium hover:underline"
                        >
                          <bdi>{review.productNameAr}</bdi>
                        </Link>
                        <bdi className="text-xs text-muted-foreground">{review.gameNameAr}</bdi>
                        <span className="text-xs text-muted-foreground">
                          {formatSince(review.createdAt)}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <bdi>{review.supplierNameAr}</bdi>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-0.5 tabular-nums">
                        <Change from={review.costBeforeUsdUnits} to={review.costAfterUsdUnits} />
                        <Badge tone={review.changeBp > 0 ? 'warning' : 'info'}>
                          <bdi dir="ltr">
                            {review.changeBp > 0 ? '+' : '−'}
                            {formatPercentBp(Math.abs(review.changeBp))}%
                          </bdi>
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Change from={review.priceBeforeUsdUnits} to={review.proposedPriceUsdUnits} />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-0.5 text-sm tabular-nums">
                        <span
                          className={
                            review.heldMarginUsdUnits < 0
                              ? 'text-status-danger-foreground'
                              : undefined
                          }
                        >
                          {t('pricing.reviews.heldMargin', {
                            amount: ltr(signed(review.heldMarginUsdUnits)),
                          })}
                        </span>
                        <span className="text-muted-foreground">
                          {t('pricing.reviews.proposedMargin', {
                            amount: ltr(signed(review.proposedMarginUsdUnits)),
                          })}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        {open ? (
                          <AvailabilityBadge availability={review.availability} />
                        ) : (
                          <Badge tone="neutral">
                            {t(`pricing.reviews.statuses.${review.status}`)}
                          </Badge>
                        )}
                        <OutcomeNote outcome={outcomes.get(review.id)} />
                      </span>
                    </TableCell>
                    {open && (
                      <TableCell>
                        <span className="flex flex-col items-stretch gap-1">
                          <Button
                            size="sm"
                            disabled={decide.isPending}
                            onClick={() => accept([review])}
                          >
                            {t('pricing.reviews.accept')}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setAdjusting(review)}>
                            {t('pricing.reviews.adjust')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setPausing(review)}>
                            {t('pricing.reviews.pause')}
                          </Button>
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={(next) => onSearch({ ...search, page: next > 1 ? next : undefined })}
              summary={t('pricing.reviews.total', { total: reviews.data.total })}
              previousLabel={t('common.previous')}
              nextLabel={t('common.next')}
            />
          </>
        ))}
      <ConfirmDialog
        open={pausing !== null}
        onClose={() => setPausing(null)}
        title={t('pricing.reviews.pauseTitle')}
        body={t('pricing.reviews.pauseBody', { name: pausing?.productNameAr ?? '' })}
        action={t('pricing.reviews.pause')}
        destructive
        pending={decide.isPending}
        onConfirm={async () => {
          if (pausing) await run([{ reviewId: pausing.id, action: 'pause' }]);
        }}
      />
      <Dialog open={adjusting !== null} onOpenChange={(value) => !value && setAdjusting(null)}>
        {adjusting && <AdjustMargin review={adjusting} onDone={() => setAdjusting(null)} />}
      </Dialog>
    </>
  );
}

/** `$0.88 → $1.10`, kept whole in the Arabic row. */
function Change({ from, to }: { from: number; to: number }) {
  return (
    <bdi dir="ltr" className="whitespace-nowrap">
      {formatUsd(from)} → <span className="font-medium">{formatUsd(to)}</span>
    </bdi>
  );
}

const signed = (units: number) => `${units < 0 ? '−' : ''}${formatUsd(Math.abs(units))}`;

/** A decision's result on its row: accepted or paused, or why it was refused. */
function OutcomeNote({ outcome }: { outcome: Outcome | undefined }) {
  const { t } = useTranslation();
  if (outcome?.result !== 'refused') return null;
  if (outcome.errorCode === 'REVIEW_STALE') {
    return (
      <span role="status" className="text-xs text-status-warning-foreground">
        {outcome.proposedPriceUsdUnits
          ? t('pricing.reviews.stale', { price: ltr(formatUsd(outcome.proposedPriceUsdUnits)) })
          : t('pricing.reviews.staleNoRoute')}
      </span>
    );
  }
  return (
    <span role="status" className="text-xs text-status-danger-foreground">
      {errorMessage(t, new ApiError(409, outcome.errorCode, undefined, outcome.errorCode ?? ''))}
    </span>
  );
}

/**
 * "تعديل الهامش" (rule P4): the product's rule form, starting from the rule that governs it and
 * the review's new cost, saved with the accept in one change after re-authentication.
 */
function AdjustMargin({ review, onDone }: { review: PriceReview; onDone: () => void }) {
  const { t } = useTranslation();
  const adjust = useAdjustMargin();
  const current = useQuery(
    previewQuery({
      target: { scope: 'product', targetId: review.productId },
      costUsdUnits: review.costAfterUsdUnits,
    }),
  );
  if (current.isPending) return null;
  if (current.isError) {
    return <FormAlert>{errorMessage(t, current.error)}</FormAlert>;
  }
  return (
    <RuleDialog
      scope="product"
      targetId={review.productId}
      targetName={review.productNameAr}
      initial={current.data.rule}
      sampleCost={formatCostUsd(review.costAfterUsdUnits)}
      onSave={(values) => adjust.mutateAsync({ id: review.id, values })}
      onDone={onDone}
    />
  );
}
