'use client';

import {
  formatUsd,
  hasLink,
  type MerchantShop,
  type ReceiptSettings,
  type RequestShop,
  SHOP_ANNOUNCEMENT_MAX,
  SHOP_BRAND_COLORS,
  type ShopSettings,
  shopAnnouncementSchema,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Meter } from '@vertex-digital/ui/components/meter';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  Share2Icon,
  XCircleIcon,
} from 'lucide-react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { saveBlob } from '@/features/merchant-tools/download';
import {
  ChosenGames,
  GamePickerDialog,
  readPickerGames,
} from '@/features/merchant-tools/game-picker';
import type { PickerGame } from '@/features/merchant-tools/game-picker-rules';
import {
  MerchantPageStatus,
  MerchantSkeleton,
  useMerchantRead,
} from '@/features/merchant-tools/merchant-state';
import { getPinnedGames, getReceiptSettings, logoPath } from '@/features/merchant-tools/requests';
import type { Result } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDate, ltr } from '@/lib/format';
import { useIdempotentRequest } from '@/lib/idempotency';
import { BrandFields } from './brand-fields';
import { tsa } from './i18n';
import { type RateDraft, RateFields, typedRate } from './rate-fields';
import {
  getHiddenGames,
  getShop,
  requestShop,
  STICKER_SIZES,
  saveHiddenGames,
  saveShopSettings,
  slugAvailable,
  stickerFile,
} from './requests';
import { colorVerdict, confirmWordTyped, normalizeColor, shopUrl, slugProblem } from './rules';
import { ShopPreview } from './shop-preview';

type ShopRead = { shop: MerchantShop | null; receipt: ReceiptSettings };

async function readShopPage(): Promise<Result<ShopRead>> {
  const [shop, receipt] = await Promise.all([getShop(), getReceiptSettings()]);
  if (!shop.ok) return shop;
  if (!receipt.ok) return receipt;
  return { ok: true, data: { shop: shop.data.shop, receipt: receipt.data } };
}

/** The store's rate the page knows: the shop's own rate in force when it follows the store. */
const knownStoreRate = (shop: MerchantShop | null) =>
  shop?.rateMode === 'store' ? shop.rate : null;

/**
 * "متجري" (S26 Screens, SH1–SH3, ST1–ST6): before a shop, the request with its live preview;
 * while it is reviewed or after a rejection, its state and reason; once approved, the shop's
 * link and QR, its stickers, today's transfers, the settings and the hidden games.
 */
export function ShopPage() {
  const read = useCallback(() => readShopPage(), []);
  const { state, setState, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton rows={4} />} />
    );
  }
  const { shop, receipt } = state.data;
  const onShop = (next: MerchantShop) =>
    setState({ status: 'ready', data: { ...state.data, shop: next } });
  const logoUrl = receipt.logoFileId ? logoPath(receipt.logoFileId) : null;
  const mayRequest =
    shop === null ||
    (shop.status === 'rejected' &&
      (shop.requestAgainAt === null || Date.parse(shop.requestAgainAt) <= Date.now()));

  if (shop === null || shop.status === 'rejected') {
    return (
      <div className="flex flex-col gap-6">
        {shop && <RejectedCard shop={shop} />}
        {mayRequest && (
          <RequestForm name={receipt.tradeName} logoUrl={logoUrl} onRequested={onShop} />
        )}
      </div>
    );
  }
  if (shop.status === 'requested') return <RequestedCard shop={shop} logoUrl={logoUrl} />;
  return <ShopOverview shop={shop} logoUrl={logoUrl} onShop={onShop} />;
}

function RejectedCard({ shop }: { shop: MerchantShop }) {
  const again = shop.requestAgainAt && Date.parse(shop.requestAgainAt) > Date.now();
  return (
    <Callout
      tone="danger"
      icon={<XCircleIcon />}
      title={tsa('request.rejectedTitle')}
      description={
        <span className="flex flex-col gap-1">
          {shop.rejectReason && (
            <span>{tsa('request.rejectedReason', { reason: shop.rejectReason })}</span>
          )}
          <span>
            {again && shop.requestAgainAt
              ? tsa('request.againAt', { date: formatDate(shop.requestAgainAt) })
              : tsa('request.againNow')}
          </span>
        </span>
      }
    />
  );
}

function RequestedCard({ shop, logoUrl }: { shop: MerchantShop; logoUrl: string | null }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Callout
        tone="info"
        icon={<ClockIcon />}
        title={tsa('request.requestedTitle')}
        description={tsa('request.requestedBody', { slug: shop.slug })}
      />
      <ShopPreview name={shop.displayName} color={shop.brandColor} logoUrl={logoUrl} />
    </div>
  );
}

type SlugState = 'idle' | 'checking' | 'free' | 'taken';

/** SH2: the typed slug checked against the API once typing pauses (only the newest answer counts). */
function useSlugCheck(slug: string): SlugState {
  const [state, setState] = useState<SlugState>('idle');
  useEffect(() => {
    if (slugProblem(slug) !== null) {
      setState('idle');
      return;
    }
    let live = true;
    setState('checking');
    const timer = setTimeout(() => {
      void slugAvailable(slug.trim().toLowerCase()).then((result) => {
        if (!live) return;
        setState(result.ok ? (result.data.available ? 'free' : 'taken') : 'idle');
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug]);
  return state;
}

/** SH1–SH3, ST1, ST3: the shop's request: slug, color and rate, with the preview beside them. */
function RequestForm({
  name,
  logoUrl,
  onRequested,
}: {
  name: string;
  logoUrl: string | null;
  onRequested: (shop: MerchantShop) => void;
}) {
  const [slug, setSlug] = useState('');
  const [color, setColor] = useState<string>(SHOP_BRAND_COLORS[0]);
  const [rate, setRate] = useState<RateDraft>({ mode: 'store', rate: '', confirm: '' });
  const [far, setFar] = useState<{ storeRate: string | null } | null>(null);
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const send = useIdempotentRequest();
  const { ref, focusInvalid } = useFocusInvalid();
  const check = useSlugCheck(slug);
  const problem = slugProblem(slug);
  const slugRefused = problem !== null || check === 'taken' || taken === slug.trim().toLowerCase();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowError(true);
    setFailure(null);
    const brandColor = normalizeColor(color);
    const ownRate = typedRate(rate);
    if (
      slugRefused ||
      colorVerdict(color) !== 'ok' ||
      brandColor === null ||
      (rate.mode === 'own' && ownRate === null) ||
      (far !== null && rate.mode === 'own' && !confirmWordTyped(rate.confirm))
    ) {
      return focusInvalid();
    }
    const body: RequestShop = {
      slug: slug.trim().toLowerCase(),
      brandColor,
      rateMode: rate.mode,
      rate: rate.mode === 'own' ? ownRate : null,
      confirmFar: far !== null && rate.mode === 'own',
    };
    setSending(true);
    const result = await send(JSON.stringify(body), (key) => requestShop(body, key));
    setSending(false);
    if (result.ok) return onRequested(result.data);
    if (result.reason === 'SHOP_RATE_CONFIRMATION_REQUIRED') {
      const storeRate = (result.details as { storeRate?: unknown } | undefined)?.storeRate;
      setFar({ storeRate: typeof storeRate === 'string' ? storeRate : null });
      return focusInvalid();
    }
    if (result.reason === 'SLUG_TAKEN') {
      setTaken(body.slug);
      return focusInvalid();
    }
    setFailure(errorText(result.reason));
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <Card className="gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold">{tsa('request.title')}</h2>
          <p className="text-sm text-muted-foreground">{tsa('request.body')}</p>
        </div>
        <form
          ref={ref}
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <Field invalid={showError && slugRefused}>
            <FieldLabel>{tsa('request.slug')}</FieldLabel>
            <div className="flex items-center gap-2" dir="ltr">
              <span className="text-sm text-muted-foreground">/s/</span>
              <Input
                name="slug"
                dir="ltr"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={30}
                className="h-11 text-md"
                value={slug}
                aria-invalid={showError && slugRefused}
                onChange={(event) => setSlug(event.target.value)}
              />
            </div>
            <FieldDescription>{tsa('request.slugHint')}</FieldDescription>
            <SlugStatus slug={slug} check={check} taken={taken} showError={showError} />
          </Field>
          <BrandFields typed={color} onChange={setColor} showError={showError} />
          <RateFields draft={rate} onChange={setRate} far={far} showError={showError} />
          {failure && <FormAlert>{failure}</FormAlert>}
          <Button type="submit" size="xl" disabled={sending} className="self-start">
            {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {sending ? tsa('request.sending') : tsa('request.submit')}
          </Button>
        </form>
      </Card>
      <ShopPreview name={name} color={normalizeColor(color)} logoUrl={logoUrl} />
    </div>
  );
}

function SlugStatus({
  slug,
  check,
  taken,
  showError,
}: {
  slug: string;
  check: SlugState;
  taken: string | null;
  showError: boolean;
}) {
  const problem = slugProblem(slug);
  if (slug.trim() === '') {
    return showError ? <FieldError match>{tsa('request.slugInvalid')}</FieldError> : null;
  }
  if (problem) {
    return (
      <FieldError match>
        {problem === 'reserved' ? tsa('request.slugReserved') : tsa('request.slugInvalid')}
      </FieldError>
    );
  }
  if (check === 'taken' || taken === slug.trim().toLowerCase()) {
    return <FieldError match>{tsa('request.slugTaken')}</FieldError>;
  }
  if (check === 'checking') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
        {tsa('request.slugChecking')}
      </p>
    );
  }
  if (check === 'free') {
    return (
      <p className="flex items-center gap-2 text-sm text-status-success-foreground" role="status">
        <CircleCheckIcon className="size-4" aria-hidden="true" />
        {tsa('request.slugFree')}
      </p>
    );
  }
  return null;
}

/** An approved shop: its state, link, QR, stickers, today's transfers, settings and hidden games. */
function ShopOverview({
  shop,
  logoUrl,
  onShop,
}: {
  shop: MerchantShop;
  logoUrl: string | null;
  onShop: (shop: MerchantShop) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <StateCard shop={shop} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <LinkCard shop={shop} />
        <LimitsCard shop={shop} />
      </div>
      {shop.status !== 'closed' && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <SettingsForm shop={shop} onShop={onShop} />
          <ShopPreview name={shop.displayName} color={shop.brandColor} logoUrl={logoUrl} />
        </div>
      )}
      {shop.status !== 'closed' && <HiddenGamesCard />}
    </div>
  );
}

function StateCard({ shop }: { shop: MerchantShop }) {
  const tone =
    shop.status === 'active' ? 'success' : shop.status === 'suspended' ? 'warning' : 'neutral';
  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{tsa('settings.state')}</span>
          <bdi className="text-lg font-bold">{shop.displayName}</bdi>
        </div>
        <Badge tone={tone}>{tsa(`states.${shop.status}`)}</Badge>
      </div>
      {shop.status === 'suspended' && (
        <Callout
          tone="warning"
          icon={<PauseCircleIcon />}
          title={tsa('settings.suspendedBody', {
            reason: shop.suspendReason ? tsa(`suspendReasons.${shop.suspendReason}`) : '—',
          })}
        />
      )}
      {shop.status === 'closed' && (
        <Callout tone="neutral" icon={<CircleAlertIcon />} title={tsa('settings.closedBody')} />
      )}
    </Card>
  );
}

/** The shop's public link with copy, share and its QR, and the sticker downloads (SP2). */
function LinkCard({ shop }: { shop: MerchantShop }) {
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [stickerFailure, setStickerFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = shopUrl(origin, shop.slug);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function share() {
    const text = tsa('settings.shareText', { name: shop.displayName });
    if (typeof navigator.share === 'function') {
      await navigator.share({ title: shop.displayName, text, url }).catch(() => undefined);
    } else {
      await copy();
    }
  }

  async function sticker(size: (typeof STICKER_SIZES)[number]) {
    setStickerFailure(null);
    setBusy(true);
    const result = await stickerFile(size);
    setBusy(false);
    if (!result.ok) return setStickerFailure(errorText(result.reason));
    saveBlob(result.blob, result.fileName);
  }

  return (
    <Card className="gap-4">
      <h2 className="text-lg font-bold">{tsa('settings.link')}</h2>
      <div className="flex flex-wrap items-center gap-4">
        {origin && (
          <QRCodeSVG
            value={url}
            size={112}
            level="M"
            marginSize={4}
            bgColor="white"
            fgColor="black"
            role="img"
            aria-label={tsa('settings.qr')}
            className="shrink-0 rounded-md"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <bdi dir="ltr" className="text-end font-medium break-all" data-testid="shop-url">
            {url}
          </bdi>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="xl" onClick={() => void copy()}>
              {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
              <span aria-live="polite">
                {copied ? tsa('settings.copied') : tsa('settings.copy')}
              </span>
            </Button>
            <Button type="button" variant="outline" size="xl" onClick={() => void share()}>
              <Share2Icon aria-hidden="true" />
              {tsa('settings.share')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className="font-medium">{tsa('settings.sticker')}</span>
        <span className="text-sm text-muted-foreground">{tsa('settings.stickerHint')}</span>
        <div className="flex flex-wrap gap-2">
          {STICKER_SIZES.map((size) => (
            <Button
              key={size}
              type="button"
              variant="outline"
              size="xl"
              disabled={busy}
              onClick={() => void sticker(size)}
            >
              <DownloadIcon aria-hidden="true" />
              {size === 'a6' ? tsa('settings.stickerA6') : tsa('settings.sticker80')}
            </Button>
          ))}
        </div>
        {stickerFailure && <FormAlert>{stickerFailure}</FormAlert>}
      </div>
    </Card>
  );
}

/** WL3, SH8: today's transfers against the daily cap, the balance cap and the customers. */
function LimitsCard({ shop }: { shop: MerchantShop }) {
  const { dailyTransferCapUsdUnits: cap, customerBalanceCapUsdUnits, customerLimit } = shop.limits;
  return (
    <Card className="gap-4">
      <h2 className="text-lg font-bold">{tsa('settings.limits')}</h2>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{tsa('settings.today')}</span>
          <span className="font-medium tabular-nums" data-testid="transferred-today">
            {tsa('settings.todayOf', {
              amount: ltr(formatUsd(shop.transferredTodayUsdUnits)),
              cap: ltr(formatUsd(cap)),
            })}
          </span>
        </div>
        <Meter
          value={Math.min(shop.transferredTodayUsdUnits, cap)}
          max={cap}
          aria-label={tsa('settings.today')}
        />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{tsa('settings.balanceCap')}</span>
        <bdi dir="ltr" className="font-medium tabular-nums">
          {formatUsd(customerBalanceCapUsdUnits)}
        </bdi>
      </div>
      <p className="text-sm text-muted-foreground">
        {tsa('settings.customerCount', { count: shop.customerCount, limit: customerLimit })}
      </p>
    </Card>
  );
}

/** ST1, ST3, ST5: color, announcement and rate; a far own rate asks for «أؤكد». */
function SettingsForm({
  shop,
  onShop,
}: {
  shop: MerchantShop;
  onShop: (shop: MerchantShop) => void;
}) {
  const [color, setColor] = useState(shop.brandColor);
  const [announcement, setAnnouncement] = useState(shop.announcement ?? '');
  const [rate, setRate] = useState<RateDraft>({
    mode: shop.rateMode,
    rate: shop.ownRate ?? '',
    confirm: '',
  });
  const [far, setFar] = useState<{ storeRate: string | null } | null>(null);
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const readOnly = shop.status !== 'active';
  const trimmed = announcement.trim();
  const announcementLink = trimmed !== '' && hasLink(trimmed);
  const announcementInvalid =
    trimmed !== '' && !announcementLink && !shopAnnouncementSchema.safeParse(trimmed).success;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowError(true);
    setFailure(null);
    setDone(false);
    const brandColor = normalizeColor(color);
    const ownRate = typedRate(rate);
    if (
      colorVerdict(color) !== 'ok' ||
      brandColor === null ||
      announcementLink ||
      announcementInvalid ||
      (rate.mode === 'own' && ownRate === null) ||
      (far !== null && rate.mode === 'own' && !confirmWordTyped(rate.confirm))
    ) {
      return focusInvalid();
    }
    const body: ShopSettings = {
      brandColor,
      announcement: trimmed === '' ? null : trimmed,
      rateMode: rate.mode,
      ...(rate.mode === 'own' && ownRate !== null && { rate: ownRate }),
      ...(far !== null && rate.mode === 'own' && { confirmFar: true }),
    };
    setSaving(true);
    const result = await saveShopSettings(body);
    setSaving(false);
    if (result.ok) {
      setFar(null);
      setShowError(false);
      setRate((current) => ({ ...current, confirm: '' }));
      setDone(true);
      return onShop(result.data);
    }
    if (result.reason === 'SHOP_RATE_CONFIRMATION_REQUIRED') {
      const storeRate = (result.details as { storeRate?: unknown } | undefined)?.storeRate;
      setFar({ storeRate: typeof storeRate === 'string' ? storeRate : knownStoreRate(shop) });
      return focusInvalid();
    }
    setFailure(errorText(result.reason));
  }

  return (
    <Card className="gap-5">
      <h2 className="text-lg font-bold">{tsa('settings.brand')}</h2>
      <form
        ref={ref}
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <fieldset disabled={readOnly || saving} className="flex flex-col gap-6">
          <BrandFields typed={color} onChange={setColor} showError={showError} />
          <Field>
            <FieldLabel render={<span />}>{tsa('settings.logo')}</FieldLabel>
            <FieldDescription>{tsa('settings.logoHint')}</FieldDescription>
            <Button
              type="button"
              variant="outline"
              size="xl"
              className="self-start"
              render={<Link href="/merchant/receipt" prefetch={false} />}
            >
              {tsa('settings.logoLink')}
            </Button>
          </Field>
          <Field invalid={showError && (announcementLink || announcementInvalid)}>
            <FieldLabel>{tsa('settings.announcement')}</FieldLabel>
            <Textarea
              name="announcement"
              rows={3}
              maxLength={SHOP_ANNOUNCEMENT_MAX}
              className="text-md"
              value={announcement}
              aria-invalid={showError && (announcementLink || announcementInvalid)}
              onChange={(event) => setAnnouncement(event.target.value)}
            />
            <FieldDescription>
              {tsa('settings.announcementHint')}{' '}
              <span dir="ltr" className="tabular-nums">
                {trimmed.length}/{SHOP_ANNOUNCEMENT_MAX}
              </span>
            </FieldDescription>
            <FieldError match={showError && announcementLink}>
              {tsa('settings.announcementLink')}
            </FieldError>
            <FieldError match={showError && announcementInvalid}>
              {tsa('settings.announcementInvalid')}
            </FieldError>
          </Field>
          <RateFields draft={rate} onChange={setRate} far={far} showError={showError} />
        </fieldset>
        {failure && <FormAlert>{failure}</FormAlert>}
        {done && (
          <p
            className="flex items-center gap-2 text-sm text-status-success-foreground"
            role="status"
          >
            <CircleCheckIcon className="size-4" aria-hidden="true" />
            {tsa('common.saved')}
          </p>
        )}
        {!readOnly && (
          <Button type="submit" size="xl" disabled={saving} className="self-start">
            {saving && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {tsa('common.save')}
          </Button>
        )}
      </form>
    </Card>
  );
}

/** ST6: the games hidden from the shop, chosen in the merchant tools' picker and saved at once. */
function HiddenGamesCard() {
  const read = useCallback(async () => {
    const [games, hidden, pinned] = await Promise.all([
      readPickerGames(),
      getHiddenGames(),
      getPinnedGames(),
    ]);
    if (!games.ok) return games;
    if (!hidden.ok) return hidden;
    return {
      ok: true as const,
      data: {
        games: games.data,
        hidden: hidden.data.gameIds,
        pinned: pinned.ok ? pinned.data.gameIds : [],
      },
    };
  }, []);
  const { state, setState, reload } = useMerchantRead(read);
  const [picking, setPicking] = useState(false);
  // The picker toggles games one by one: the choice is saved once, when it closes.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton rows={1} />} />
    );
  }
  const { games, hidden, pinned } = state.data;
  const chosen: PickerGame[] = games.filter((game) => hidden.includes(game.id));
  const open = () => {
    setDraft(hidden);
    setPicking(true);
  };
  const close = (next: boolean) => {
    setPicking(next);
    if (next || draft === null) return;
    const changed = draft.length !== hidden.length || draft.some((id) => !hidden.includes(id));
    setDraft(null);
    if (changed) void save(draft);
  };

  async function save(ids: string[]) {
    setFailure(null);
    setDone(false);
    setSaving(true);
    const result = await saveHiddenGames(ids);
    setSaving(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    setDone(true);
    if (state.status === 'ready') {
      setState({ status: 'ready', data: { ...state.data, hidden: result.data.gameIds } });
    }
  }

  return (
    <Card className="gap-4" data-testid="hidden-games">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">{tsa('settings.hidden')}</h2>
        <p className="text-sm text-muted-foreground">{tsa('settings.hiddenHint')}</p>
      </div>
      {chosen.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">{tsa('settings.hiddenNone')}</span>
          <Button type="button" variant="outline" size="xl" disabled={saving} onClick={open}>
            {tsa('settings.hiddenChoose')}
          </Button>
        </div>
      ) : (
        <ChosenGames games={chosen} onChange={open} />
      )}
      <GamePickerDialog
        open={picking}
        onOpenChange={close}
        multiple
        games={games}
        pinned={pinned}
        selected={draft ?? hidden}
        onPick={setDraft}
      />
      {failure && <FormAlert>{failure}</FormAlert>}
      {done && (
        <p className="flex items-center gap-2 text-sm text-status-success-foreground" role="status">
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          {tsa('settings.hiddenSaved')}
        </p>
      )}
    </Card>
  );
}
