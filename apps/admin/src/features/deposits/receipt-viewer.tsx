import type { AdminDeposit } from '@vertex-digital/contracts';
import {
  Button,
  Card,
  EmptyState,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import {
  ExternalLinkIcon,
  ImageOffIcon,
  type LucideIcon,
  RotateCwIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import { receiptUrl } from './deposits.queries';
import { receiptLayout } from './receipt-layout';

const ZOOMS = [1, 1.5, 2, 3] as const;

/**
 * The receipt, zoomed and rotated (the review reads small print on phone screenshots); after a
 * clearer-receipt request both receipts, the newest first. The image is laid out at its turned
 * and zoomed size (F4-2): a CSS transform alone keeps the unturned box, so a quarter turn cut the
 * receipt's top off and a zoom pushed its start edge out of reach of the scroll.
 */
export function ReceiptViewer({ deposit }: { deposit: AdminDeposit }) {
  const { t } = useTranslation();
  const receipts = [...deposit.receipts].reverse();
  const [shown, setShown] = useState(receipts[0]?.id ?? '');
  const [zoom, setZoom] = useState(0);
  const [turns, setTurns] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const frameWidth = useContentWidth(frame);
  const [ratio, setRatio] = useState<number | null>(null);

  if (receipts.length === 0) {
    return <EmptyState icon={<ImageOffIcon />} title={t('deposits.receipt.none')} />;
  }
  const receipt = receipts.find((item) => item.id === shown) ?? receipts[0];
  const url = receiptUrl(deposit.id, receipt?.id ?? '');
  const size =
    ratio && frameWidth ? receiptLayout(frameWidth, ratio, turns, ZOOMS[zoom] ?? 1) : null;

  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {receipts.length > 1 ? (
          <Tabs
            value={receipt?.id}
            onValueChange={(value) => {
              setShown(String(value));
              setRatio(null);
            }}
          >
            <TabsList>
              {receipts.map((item, index) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {index === 0 ? t('deposits.receipt.latest') : t('deposits.receipt.earlier')}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <h2 className="text-lg font-bold">{t('deposits.receipt.title')}</h2>
        )}
        <div className="flex items-center gap-1">
          <ToolButton
            icon={ZoomOutIcon}
            label={t('deposits.receipt.zoomOut')}
            disabled={zoom === 0}
            onClick={() => setZoom(zoom - 1)}
          />
          <ToolButton
            icon={ZoomInIcon}
            label={t('deposits.receipt.zoomIn')}
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom(zoom + 1)}
          />
          <ToolButton
            icon={RotateCwIcon}
            label={t('deposits.receipt.rotate')}
            onClick={() => setTurns((turns + 1) % 4)}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('deposits.receipt.open')}
                  render={<a href={url} target="_blank" rel="noreferrer" />}
                />
              }
            >
              <ExternalLinkIcon />
            </TooltipTrigger>
            <TooltipContent>{t('deposits.receipt.open')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div
        ref={frame}
        className="max-h-[70vh] min-h-64 overflow-auto rounded-md border border-border bg-muted p-2"
      >
        <div
          className="mx-auto grid grid-cols-1 grid-rows-1 place-items-center"
          style={size ? { width: size.boxWidth, height: size.boxHeight } : undefined}
        >
          <img
            key={url}
            src={url}
            alt={t('deposits.receipt.alt', { reference: deposit.referenceCode })}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0) setRatio(image.naturalHeight / image.naturalWidth);
            }}
            className={size ? 'max-w-none' : 'max-w-full'}
            style={
              size
                ? {
                    width: size.width,
                    height: size.height,
                    transform: `rotate(${turns * 90}deg)`,
                  }
                : undefined
            }
          />
        </div>
      </div>
      {receipt && (
        <p className="text-xs text-muted-foreground">
          {t('deposits.receipt.at', { date: formatDateTime(receipt.createdAt) })}
        </p>
      )}
    </Card>
  );
}

/** The element's content width, followed as the window or the layout changes. */
function useContentWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function ToolButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
