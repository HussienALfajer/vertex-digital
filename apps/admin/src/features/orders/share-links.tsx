import { Link } from '@tanstack/react-router';
import { type AdminOrder, formatUsd, revokeShareLinkSchema } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@vertex-digital/ui';
import { GiftIcon, ShoppingCartIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { STATUS_TONES } from './order-labels';
import { useRevokeShareLink } from './orders.queries';

type ShareLinkRow = AdminOrder['shareLinks'][number];

/** The first 8 characters of a checkout id: the "سلة" badge (S10 rule AD2). */
export const shortCheckoutId = (id: string) => id.slice(0, 8);

/**
 * S10 rule AD1: the checkout this order was paid in, with its total and the links to its other
 * orders in line order.
 */
export function CheckoutBlock({
  order,
  checkout,
}: {
  order: AdminOrder;
  checkout: NonNullable<AdminOrder['checkout']>;
}) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ShoppingCartIcon className="size-5" aria-hidden="true" />
          {t('orders.checkout.title', { count: checkout.orderCount })}
        </CardTitle>
        <Badge tone={checkout.finishedAt ? 'success' : 'info'}>
          {checkout.finishedAt
            ? t('orders.checkout.finished', { date: formatDateTime(checkout.finishedAt) })
            : t('orders.checkout.open')}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('orders.checkout.total')}{' '}
        <bdi dir="ltr" className="font-medium text-foreground tabular-nums">
          {formatUsd(checkout.totalUsdUnits)}
        </bdi>{' '}
        · <bdi dir="ltr">{shortCheckoutId(checkout.id)}</bdi>
      </p>
      <ul className="flex flex-wrap gap-2">
        {checkout.orders.map((item) => (
          <li key={item.id}>
            {item.id === order.id ? (
              <span className="flex items-center gap-2 rounded-md border border-primary px-3 py-1.5 text-sm">
                <span className="tabular-nums">{item.line}.</span>
                <bdi dir="ltr" className="font-medium">
                  {item.number}
                </bdi>
                <Badge tone={STATUS_TONES[item.status]}>
                  {t(`orders.statuses.${item.status}`)}
                </Badge>
              </span>
            ) : (
              <Link
                to="/orders/$id"
                params={{ id: item.id }}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                <span className="tabular-nums">{item.line}.</span>
                <bdi dir="ltr" className="font-medium underline-offset-4 hover:underline">
                  {item.number}
                </bdi>
                <Badge tone={STATUS_TONES[item.status]}>
                  {t(`orders.statuses.${item.status}`)}
                </Badge>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** S10 rule AD1: the gift's sender name and message, as text. */
export function GiftBlock({ gift }: { gift: NonNullable<AdminOrder['gift']> }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle className="flex items-center gap-2">
        <GiftIcon className="size-5" aria-hidden="true" />
        {t('orders.gift.title')}
      </CardTitle>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{t('orders.gift.sender')}</dt>
          <dd>{gift.senderName ?? t('orders.gift.none')}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{t('orders.gift.message')}</dt>
          <dd className="whitespace-pre-line break-words">
            {gift.message ?? t('orders.gift.none')}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * S10 rule AD1: every share link of the order (kind, created, state, who revoked it and why),
 * and "إلغاء الرابط" on a live one, with a reason (5–500) and the audit entry
 * `order.share_revoked`. No re-authentication: it only removes exposure.
 */
export function ShareLinksBlock({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState<ShareLinkRow | null>(null);
  return (
    <Card className="gap-3">
      <CardTitle>{t('orders.shareLinks.title')}</CardTitle>
      {order.shareLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('orders.shareLinks.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('orders.shareLinks.kind')}</TableHead>
              <TableHead>{t('orders.shareLinks.created')}</TableHead>
              <TableHead>{t('orders.shareLinks.state')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('orders.shareLinks.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.shareLinks.map((link) => (
              <TableRow key={link.id}>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    {t(`orders.shareLinks.kinds.${link.kind}`)}
                    {link.kind === 'receipt' && (
                      <span className="text-xs text-muted-foreground">
                        {t(
                          link.showPrice
                            ? 'orders.shareLinks.withPrice'
                            : 'orders.shareLinks.noPrice',
                        )}
                        {' · '}
                        {t(`orders.shareLinks.displays.${link.playerDisplay}`)}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(link.createdAt)}
                </TableCell>
                <TableCell className="min-w-48 whitespace-normal">
                  {link.revokedAt ? (
                    <span className="flex flex-col gap-1">
                      <Badge tone="neutral">
                        {t('orders.shareLinks.revokedBy', {
                          by: t(`orders.shareLinks.revokers.${link.revokedBy ?? 'customer'}`),
                          date: formatDateTime(link.revokedAt),
                        })}
                      </Badge>
                      {link.revokeReason && (
                        <span className="text-sm break-words text-muted-foreground">
                          {link.revokeReason}
                        </span>
                      )}
                    </span>
                  ) : (
                    <Badge tone="success">{t('orders.shareLinks.live')}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {!link.revokedAt && (
                    <Button variant="outline" size="sm" onClick={() => setRevoking(link)}>
                      {t('orders.shareLinks.revoke')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        {revoking && (
          <RevokeDialog order={order} link={revoking} onDone={() => setRevoking(null)} />
        )}
      </Dialog>
    </Card>
  );
}

function RevokeDialog({
  order,
  link,
  onDone,
}: {
  order: AdminOrder;
  link: ShareLinkRow;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeShareLink(order.id);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = revokeShareLinkSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await revoke.mutateAsync({ linkId: link.id, body: parsed.data });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('orders.shareLinks.revokeTitle')}</DialogTitle>
        <DialogDescription>
          {t('orders.shareLinks.revokeDescription', {
            kind: t(`orders.shareLinks.kinds.${link.kind}`),
            number: order.number,
          })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('orders.decisions.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={invalid}>{t('orders.decisions.reasonError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={revoke.isPending}>
            {revoke.isPending ? t('orders.decisions.submitting') : t('orders.shareLinks.revoke')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
