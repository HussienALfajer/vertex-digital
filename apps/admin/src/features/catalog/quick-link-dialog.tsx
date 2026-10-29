import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type CatalogImage,
  formatUsd,
  type Product,
  QUICK_CAMPAIGN_PATTERN,
} from '@vertex-digital/contracts';
import {
  Button,
  Checkbox,
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
import { BarChart3Icon, DownloadIcon, PrinterIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { reportClientError } from '../../lib/report-error';
import {
  BADGE_SHARE,
  CARD_QR,
  canvasBlob,
  coverBadge,
  drawCard,
  QR_DARK,
  rasterize,
  svgMarkup,
} from './quick-link-art';

const QR_SIZE = 176;
/** The PNG is drawn larger than shown, for print. */
const PNG_SIZE = 1024;

/** The link with its campaign tag (DL1), or the plain link while the tag is empty or invalid. */
export function taggedLink(url: string, campaign: string): string {
  return QUICK_CAMPAIGN_PATTERN.test(campaign) ? `${url}?c=${campaign}` : url;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Released after the browser has started the download: revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A pack's direct buy link (S22 DL5): the permanent `/q/<code>` link with "نسخ", a campaign field
 * that builds the tagged link, and its QR (level H, the game's cover in its middle) to download as
 * PNG (for print) or SVG (for design), or as a printed card with the pack's names.
 */
export function QuickLinkDialog({
  product,
  gameName,
  cover,
}: {
  product: Product;
  gameName: string;
  cover: CatalogImage | null;
}) {
  const { t } = useTranslation();
  const [campaign, setCampaign] = useState('');
  const [withPrice, setWithPrice] = useState(false);
  const [busy, setBusy] = useState(false);
  const priceId = useId();
  const svg = useRef<SVGSVGElement>(null);
  // A cover that cannot be read leaves the plain QR.
  const badge = useQuery({
    queryKey: ['catalog', 'quick-link-cover', cover?.id],
    queryFn: () => coverBadge(cover?.url ?? ''),
    enabled: cover !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const drawing = cover !== null && badge.isPending;
  const badgeSize = Math.round(QR_SIZE * BADGE_SHARE);
  const invalid = campaign !== '' && !QUICK_CAMPAIGN_PATTERN.test(campaign);
  const link = taggedLink(product.quickLinkUrl, campaign);
  const fileName = `${product.quickCode}${QUICK_CAMPAIGN_PATTERN.test(campaign) ? `-${campaign}` : ''}`;
  const current = () => {
    if (!svg.current) throw new Error('The QR is not rendered');
    return svg.current;
  };
  const download = (make: () => Promise<void>) => {
    setBusy(true);
    make()
      .catch(reportClientError)
      .finally(() => setBusy(false));
  };

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('catalog.quickLink.title', { name: product.nameAr })}</DialogTitle>
        <DialogDescription>{t('catalog.quickLink.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-5">
        <Field invalid={invalid}>
          <FieldLabel>{t('catalog.quickLink.campaign')}</FieldLabel>
          <Input
            dir="ltr"
            value={campaign}
            maxLength={32}
            autoComplete="off"
            placeholder="whatsapp"
            aria-invalid={invalid}
            onChange={(event) => setCampaign(event.target.value.trim())}
          />
          <FieldDescription>{t('catalog.quickLink.campaignHelp')}</FieldDescription>
          <FieldError match={invalid}>{t('catalog.quickLink.campaignInvalid')}</FieldError>
        </Field>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
          <bdi dir="ltr" className="min-w-0 flex-1 truncate text-sm" data-testid="quick-link">
            {link}
          </bdi>
          <CopyButton value={link} label={t('catalog.quickLink.copy')} />
        </div>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0 rounded-lg bg-white p-2">
            <QRCodeSVG
              ref={svg}
              value={link}
              size={QR_SIZE}
              level="H"
              marginSize={2}
              fgColor={QR_DARK}
              bgColor="white"
              imageSettings={
                badge.data
                  ? { src: badge.data, width: badgeSize, height: badgeSize, excavate: true }
                  : undefined
              }
              role="img"
              aria-label={t('catalog.quickLink.qr')}
              aria-busy={drawing}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={drawing || busy}
                onClick={() =>
                  download(async () => {
                    const canvas = await rasterize(current(), PNG_SIZE);
                    save(await canvasBlob(canvas), `${fileName}.png`);
                  })
                }
              >
                <DownloadIcon />
                {t('catalog.quickLink.png')}
              </Button>
              <Button
                variant="outline"
                disabled={drawing || busy}
                onClick={() =>
                  save(
                    new Blob([svgMarkup(current())], { type: 'image/svg+xml' }),
                    `${fileName}.svg`,
                  )
                }
              >
                <DownloadIcon />
                {t('catalog.quickLink.svg')}
              </Button>
            </div>
            <div className="flex flex-col items-start gap-2 border-t border-border pt-3">
              <label
                htmlFor={priceId}
                className="flex cursor-pointer items-center gap-3 text-sm font-medium"
              >
                <Checkbox
                  id={priceId}
                  checked={withPrice}
                  disabled={product.priceUsdUnits === null}
                  onCheckedChange={(value) => setWithPrice(value)}
                />
                {t('catalog.quickLink.cardPrice')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('catalog.quickLink.cardPriceHelp')}
              </p>
              <Button
                disabled={drawing || busy}
                onClick={() =>
                  download(async () => {
                    const qr = await rasterize(current(), CARD_QR);
                    const price = product.priceUsdUnits;
                    const card = await drawCard(qr, {
                      packName: product.nameAr,
                      gameName,
                      callToAction: t('catalog.quickLink.cardCallToAction'),
                      price: withPrice && price !== null ? formatUsd(price) : null,
                      link,
                    });
                    save(await canvasBlob(card), `${fileName}-card.png`);
                  })
                }
              >
                <PrinterIcon />
                {t('catalog.quickLink.card')}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          render={<Link to="/catalog/quick-links" search={{ productId: product.id }} />}
        >
          <BarChart3Icon />
          {t('catalog.quickLink.stats')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
