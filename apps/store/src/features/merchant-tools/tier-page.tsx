'use client';

import {
  certificatePath,
  formatUsd,
  type MerchantCertificate,
  type MerchantTierSummary,
  type MerchantTierTable,
} from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui/components/table';
import { TierBadge } from '@vertex-digital/ui/components/tier-badge';
import {
  CalendarClockIcon,
  ImageDownIcon,
  PrinterIcon,
  RefreshCwIcon,
  ScrollTextIcon,
} from 'lucide-react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { getCertificate, getTierHistory, getTierTable, reissueCertificate } from './requests';
import { monthLabel } from './statement-document';
import { drawSticker, type StickerShape } from './sticker';
import { TierCard, tierGrantLines } from './tier-card';
import { approvedLine, tierBadgeLabel } from './tier-parts';
import { useMerchantTier } from './tier-state';

/**
 * "فئتك" (S23 PG2, PG4, PG5, ID7, ID8): the tier card, the forecast, the tier table (cards on a
 * phone, a table from tablet) with three packs' prices on each tier's list, the history, and the
 * certificate's print, reissue and the shop sticker. Read live, never cached.
 */
export function TierPage() {
  const { tier, failed, reload } = useMerchantTier();
  return (
    <div className="flex flex-col gap-6" data-testid="tier-page">
      {tier ? (
        <>
          <TierCard tier={tier} withLink={false} />
          <Forecast tier={tier} />
        </>
      ) : failed ? (
        <MerchantPageStatus
          state={{ status: 'failed' }}
          onRetry={() => void reload()}
          skeleton={null}
        />
      ) : (
        <Skeleton className="h-64 w-full rounded-xl" aria-hidden="true" />
      )}
      <TierTableSection />
      <History />
      <Certificate />
    </div>
  );
}

/** PG4: from the 5th, this month at its daily pace; labelled as an estimate. */
function Forecast({ tier }: { tier: MerchantTierSummary }) {
  const forecast = tier.forecast;
  let text = tm('tier.page.forecastEarly');
  if (forecast?.kind === 'reach' && tier.progress.next) {
    const [year, month] = tier.month.split('-');
    text = tm('tier.page.forecastReach', {
      name: tm(`tier.names.${tier.progress.next.tier}`),
      date: dateOfMonth(`${year}-${month}-${String(forecast.day).padStart(2, '0')}`),
    });
  } else if (forecast?.kind === 'total') {
    text = tm('tier.page.forecastTotal', { amount: ltr(formatUsd(forecast.projectedUsdUnits)) });
  }
  return (
    <Card className="gap-2" data-testid="tier-forecast">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClockIcon className="size-5" aria-hidden="true" />
          {tm('tier.page.forecastTitle')}
        </CardTitle>
      </CardHeader>
      <p className="text-md">{text}</p>
      {forecast && <p className="text-xs text-muted-foreground">{tm('tier.page.forecastNote')}</p>}
    </Card>
  );
}

const dayAndMonth = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** "22 نوفمبر" for a `YYYY-MM-DD` day. */
const dateOfMonth = (day: string) => dayAndMonth.format(new Date(`${day}T12:00:00Z`));

/** PG2: the tiers, their thresholds and privileges, and three packs' prices on each. */
function TierTableSection() {
  const read = useCallback(() => getTierTable(), []);
  const { state, reload } = useMerchantRead(read);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="tier-table-title">
      <div className="flex flex-col gap-1">
        <h2 id="tier-table-title" className="text-lg font-bold">
          {tm('tier.page.tableTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">{tm('tier.page.tableHint')}</p>
      </div>
      {state.status === 'ready' ? (
        <TierTable table={state.data} />
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<MerchantSkeleton rows={4} />}
        />
      )}
    </section>
  );
}

function thresholdText(row: MerchantTierTable['tiers'][number]): string {
  if (row.tier === 'bronze') return tm('tier.page.bronzeThreshold');
  if (!row.available || row.thresholdUsdUnits === null) return tm('tier.page.unavailable');
  return tm('tier.page.thresholdFrom', { amount: ltr(formatUsd(row.thresholdUsdUnits)) });
}

const priceText = (price: number | null) =>
  price === null ? tm('tier.page.noPrice') : formatUsd(price);

function TierTable({ table }: { table: MerchantTierTable }) {
  const packName = (index: number) => {
    const pack = table.packs[index];
    return pack ? `${pack.nameAr} · ${pack.gameNameAr}` : '';
  };
  return (
    <div data-testid="tier-table">
      {/* Phone: one card per tier. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {table.tiers.map((row) => (
          <li key={row.tier}>
            <Card
              className={`gap-3 ${row.tier === table.current ? 'border-primary' : ''}`}
              aria-current={row.tier === table.current ? 'true' : undefined}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TierBadge tier={row.tier} label={tierBadgeLabel(row.tier)} />
                {row.tier === table.current && (
                  <span className="text-sm font-medium text-accent-text">
                    {tm('tier.page.you')}
                  </span>
                )}
              </div>
              <p className="text-sm">{thresholdText(row)}</p>
              <dl className="flex flex-col gap-1 text-sm">
                {row.prices.map((price, index) => (
                  <div key={table.packs[index]?.productId} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">
                      <bdi>{packName(index)}</bdi>
                    </dt>
                    <dd>
                      <bdi dir="ltr" className="tabular-nums">
                        {priceText(price)}
                      </bdi>
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {tierGrantLines(row.privileges).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </ul>
      {/* Tablet and up: one table. */}
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tm('tier.page.tier')}</TableHead>
              <TableHead>{tm('tier.page.threshold')}</TableHead>
              {table.packs.map((pack) => (
                <TableHead key={pack.productId}>
                  <bdi>{pack.nameAr}</bdi>
                  <span className="block text-xs font-normal">{pack.gameNameAr}</span>
                </TableHead>
              ))}
              <TableHead>{tm('tier.page.privileges')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.tiers.map((row) => (
              <TableRow
                key={row.tier}
                aria-current={row.tier === table.current ? 'true' : undefined}
                className={row.tier === table.current ? 'bg-muted' : undefined}
              >
                <TableCell>
                  <span className="flex flex-col items-start gap-1">
                    <TierBadge tier={row.tier} size="sm" label={tierBadgeLabel(row.tier)} />
                    {row.tier === table.current && (
                      <span className="text-xs font-medium text-accent-text">
                        {tm('tier.page.you')}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell>{thresholdText(row)}</TableCell>
                {row.prices.map((price, index) => (
                  <TableCell key={table.packs[index]?.productId}>
                    <bdi dir="ltr" className="tabular-nums">
                      {priceText(price)}
                    </bdi>
                  </TableCell>
                ))}
                <TableCell className="text-xs">
                  <ul className="flex flex-col gap-0.5">
                    {tierGrantLines(row.privileges).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {table.packs.length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">{tm('tier.page.noPacks')}</p>
      )}
    </div>
  );
}

/** PG5: the months held, this month live on top. */
function History() {
  const read = useCallback(() => getTierHistory(), []);
  const { state, reload } = useMerchantRead(read);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollTextIcon className="size-5" aria-hidden="true" />
          {tm('tier.page.historyTitle')}
        </CardTitle>
      </CardHeader>
      {state.status === 'ready' ? (
        <>
          <ul className="flex flex-col divide-y divide-border" data-testid="tier-history">
            {state.data.items.map((item) => (
              <li key={item.month} className="flex items-center justify-between gap-3 py-3">
                <span className="flex flex-col">
                  <span className="font-medium">{monthLabel(item.month)}</span>
                  {item.current && (
                    <span className="text-xs text-muted-foreground">{tm('tier.page.now')}</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <bdi dir="ltr" className="text-sm tabular-nums">
                    {formatUsd(item.netPurchasesUsdUnits)}
                  </bdi>
                  <TierBadge tier={item.tier} size="sm" label={tierBadgeLabel(item.tier)} />
                </span>
              </li>
            ))}
          </ul>
          {state.data.items.length <= 1 && (
            <CardDescription>{tm('tier.page.historyEmpty')}</CardDescription>
          )}
        </>
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<MerchantSkeleton rows={2} />}
        />
      )}
    </Card>
  );
}

/** ID7, ID8: print the certificate, draw the sticker, reissue the code. */
function Certificate() {
  const read = useCallback(() => getCertificate(), []);
  const { state, setState, reload } = useMerchantRead(read);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const qrRef = useRef<SVGSVGElement>(null);

  async function reissue() {
    setPending(true);
    setFailure(null);
    setNotice(null);
    const result = await reissueCertificate();
    setPending(false);
    setConfirm(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    setState({ status: 'ready', data: result.data });
    setNotice(tm('tier.page.reissueDone'));
  }

  async function sticker(certificate: MerchantCertificate, shape: StickerShape) {
    setFailure(null);
    const svg = qrRef.current;
    if (!svg) return;
    try {
      const blob = await drawSticker(
        shape,
        {
          tier: certificate.tier,
          tradeName: certificate.tradeName,
          approved: approvedLine(certificate.tier),
          domain: window.location.host,
        },
        svg,
      );
      const file = new File([blob], `vertex-${shape}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] }).catch(() => undefined);
        return;
      }
      const { saveBlob } = await import('./download');
      saveBlob(blob, file.name);
    } catch {
      setFailure(tm('tier.page.stickerFailed'));
    }
  }

  return (
    <Card className="gap-4" data-testid="tier-certificate">
      <CardHeader>
        <CardTitle>{tm('tier.page.certificateTitle')}</CardTitle>
        <CardDescription>{tm('tier.page.certificateBody')}</CardDescription>
      </CardHeader>
      {state.status === 'ready' ? (
        <>
          <QRCodeSVG
            ref={qrRef}
            value={`${window.location.origin}${certificatePath(state.data.code)}`}
            size={160}
            level="M"
            marginSize={4}
            bgColor="white"
            fgColor="black"
            className="hidden"
            aria-hidden="true"
          />
          <div className="flex flex-wrap gap-3">
            <Button size="xl" render={<Link href="/merchant/certificate/print" prefetch={false} />}>
              <PrinterIcon aria-hidden="true" />
              {tm('tier.page.print')}
            </Button>
            <Button variant="outline" size="xl" onClick={() => void sticker(state.data, 'square')}>
              <ImageDownIcon aria-hidden="true" />
              {tm('tier.page.stickerSquare')}
            </Button>
            <Button variant="outline" size="xl" onClick={() => void sticker(state.data, 'story')}>
              <ImageDownIcon aria-hidden="true" />
              {tm('tier.page.stickerStory')}
            </Button>
            <AlertDialog open={confirm} onOpenChange={setConfirm}>
              <Button variant="ghost" size="xl" onClick={() => setConfirm(true)}>
                <RefreshCwIcon aria-hidden="true" />
                {tm('tier.page.reissue')}
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{tm('tier.page.reissue')}</AlertDialogTitle>
                  <AlertDialogDescription>{tm('tier.page.reissueConfirm')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" size="xl" />}>
                    {tm('tier.page.cancel')}
                  </AlertDialogClose>
                  <Button size="xl" disabled={pending} onClick={() => void reissue()}>
                    {tm('tier.page.reissue')}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          {notice && (
            <p className="text-sm text-status-success-foreground" role="status">
              {notice}
            </p>
          )}
          {failure && <FormAlert>{failure}</FormAlert>}
        </>
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<Skeleton className="h-11 w-full" />}
        />
      )}
    </Card>
  );
}
