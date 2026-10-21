import { Link } from '@tanstack/react-router';
import { type Product, QUICK_CAMPAIGN_PATTERN } from '@vertex-digital/contracts';
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
import { BarChart3Icon, DownloadIcon } from 'lucide-react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';

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
 * that builds the tagged link, and its QR to download as PNG (for print) or SVG (for design).
 */
export function QuickLinkDialog({ product }: { product: Product }) {
  const { t } = useTranslation();
  const [campaign, setCampaign] = useState('');
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const invalid = campaign !== '' && !QUICK_CAMPAIGN_PATTERN.test(campaign);
  const link = taggedLink(product.quickLinkUrl, campaign);
  const fileName = `${product.quickCode}${QUICK_CAMPAIGN_PATTERN.test(campaign) ? `-${campaign}` : ''}`;

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
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG
              ref={svg}
              value={link}
              size={176}
              marginSize={1}
              role="img"
              aria-label={t('catalog.quickLink.qr')}
            />
          </div>
          {/* The PNG is drawn larger than shown, for print. */}
          <QRCodeCanvas ref={canvas} value={link} size={1024} marginSize={2} className="hidden" />
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              onClick={() =>
                canvas.current?.toBlob((blob) => blob && save(blob, `${fileName}.png`), 'image/png')
              }
            >
              <DownloadIcon />
              {t('catalog.quickLink.png')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!svg.current) return;
                const markup = new XMLSerializer().serializeToString(svg.current);
                save(new Blob([markup], { type: 'image/svg+xml' }), `${fileName}.svg`);
              }}
            >
              <DownloadIcon />
              {t('catalog.quickLink.svg')}
            </Button>
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
