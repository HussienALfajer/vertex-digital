'use client';

import {
  type AlertSettings,
  formatAmountInput,
  formatUsd,
  type MerchantAlert,
  type MerchantGame,
  WATCHES_MAX,
  type Watches,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Switch } from '@vertex-digital/ui/components/switch';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { BellOffIcon } from 'lucide-react';
import { type FormEvent, useCallback, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { parseAlertSettings } from './form';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import {
  getAlertSettings,
  getAlerts,
  getMerchantGames,
  getWatches,
  saveAlertSettings,
  saveWatches,
} from './requests';

interface AlertsData {
  watches: Watches;
  games: MerchantGame[];
  settings: AlertSettings;
  alerts: MerchantAlert[];
  nextCursor: string | null;
}

/**
 * "التنبيهات" (S21 F37, AL1–AL6): the follows (games and packs, with suggestions from the last 30
 * days), the low-balance threshold and the daily email, and the last 90 days of alerts.
 */
export function AlertsPage() {
  const read = useCallback(async () => {
    const [watches, games, settings, alerts] = [
      await getWatches(),
      await getMerchantGames(),
      await getAlertSettings(),
      await getAlerts(null),
    ];
    if (!watches.ok) return watches;
    if (!games.ok) return games;
    if (!settings.ok) return settings;
    if (!alerts.ok) return alerts;
    return {
      ok: true as const,
      data: {
        watches: watches.data,
        games: games.data.items,
        settings: settings.data,
        alerts: alerts.data.items,
        nextCursor: alerts.data.nextCursor,
      } satisfies AlertsData,
    };
  }, []);
  const { state, setState, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton />}
      />
    );
  }
  const data = state.data;
  const update = (changes: Partial<AlertsData>) =>
    setState({ status: 'ready', data: { ...data, ...changes } });
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <FollowsCard
        watches={data.watches}
        games={data.games}
        onSaved={(watches) => update({ watches })}
      />
      <div className="flex flex-col gap-6">
        <SettingsCard saved={data.settings} onSaved={(settings) => update({ settings })} />
        <EventsCard
          alerts={data.alerts}
          nextCursor={data.nextCursor}
          onMore={(alerts, nextCursor) =>
            update({ alerts: [...data.alerts, ...alerts], nextCursor })
          }
        />
      </div>
    </div>
  );
}

function FollowsCard({
  watches,
  games,
  onSaved,
}: {
  watches: Watches;
  games: MerchantGame[];
  onSaved: (watches: Watches) => void;
}) {
  const [query, setQuery] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const gameIds = watches.games.map((row) => row.gameId);
  const productIds = watches.products.map((row) => row.productId);

  async function save(next: { gameIds: string[]; productIds: string[] }) {
    setFailure(null);
    setPending(true);
    const result = await saveWatches(next);
    setPending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    onSaved(result.data);
  }

  const shown = games.filter((game) => game.nameAr.includes(query.trim()));
  return (
    <Card data-testid="merchant-follows">
      <CardHeader>
        <CardTitle>{tm('alerts.followsTitle')}</CardTitle>
        <CardDescription>
          {tm('alerts.followsBody')}{' '}
          {tm('alerts.count', { count: gameIds.length + productIds.length })}
        </CardDescription>
      </CardHeader>
      {failure && <FormAlert>{failure}</FormAlert>}
      <section className="flex flex-col gap-3">
        <h3 className="font-medium">{tm('alerts.games')}</h3>
        <Input
          type="search"
          aria-label={tm('alerts.searchGames')}
          placeholder={tm('alerts.searchGames')}
          className="h-11 text-md"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
          {shown.map((game) => {
            const followed = gameIds.includes(game.id);
            return (
              <li key={game.id} className="flex min-h-12 items-center justify-between gap-3">
                <span id={`follow-${game.id}`}>{game.nameAr}</span>
                <Switch
                  aria-labelledby={`follow-${game.id}`}
                  checked={followed}
                  disabled={
                    pending || (!followed && gameIds.length + productIds.length >= WATCHES_MAX)
                  }
                  onCheckedChange={(checked) =>
                    void save({
                      gameIds: checked
                        ? [...gameIds, game.id]
                        : gameIds.filter((id) => id !== game.id),
                      productIds,
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{tm('alerts.products')}</h3>
        {watches.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('alerts.productsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {watches.products.map((row) => (
              <li key={row.productId} className="flex min-h-12 items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span>{row.nameAr}</span>
                  <span className="text-sm text-muted-foreground">{row.gameNameAr}</span>
                </span>
                <Button
                  variant="ghost"
                  size="xl"
                  disabled={pending}
                  onClick={() =>
                    void save({
                      gameIds,
                      productIds: productIds.filter((id) => id !== row.productId),
                    })
                  }
                >
                  {tm('alerts.unfollow')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{tm('alerts.suggestions')}</h3>
        {watches.suggestions.products.length + watches.suggestions.games.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('alerts.suggestionsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {watches.suggestions.games.map((row) => (
              <li key={row.gameId} className="flex min-h-12 items-center justify-between gap-3">
                <span>{row.nameAr}</span>
                <Button
                  variant="outline"
                  size="xl"
                  disabled={pending}
                  onClick={() => void save({ gameIds: [...gameIds, row.gameId], productIds })}
                >
                  {tm('alerts.follow')}
                </Button>
              </li>
            ))}
            {watches.suggestions.products.map((row) => (
              <li key={row.productId} className="flex min-h-12 items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span>{row.nameAr}</span>
                  <span className="text-sm text-muted-foreground">{row.gameNameAr}</span>
                </span>
                <Button
                  variant="outline"
                  size="xl"
                  disabled={pending}
                  onClick={() => void save({ gameIds, productIds: [...productIds, row.productId] })}
                >
                  {tm('alerts.follow')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

function SettingsCard({
  saved,
  onSaved,
}: {
  saved: AlertSettings;
  onSaved: (settings: AlertSettings) => void;
}) {
  const [threshold, setThreshold] = useState(
    saved.lowBalanceUsdUnits === null ? '' : formatAmountInput('USD', saved.lowBalanceUsdUnits),
  );
  const [dailyEmail, setDailyEmail] = useState(saved.dailyEmail);
  const [invalid, setInvalid] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const input = parseAlertSettings(threshold, dailyEmail);
    setInvalid(input === undefined);
    if (input === undefined) return focusInvalid();
    setPending(true);
    const result = await saveAlertSettings(input);
    setPending(false);
    if (!result.ok) return setMessage({ ok: false, text: errorText(result.reason) });
    setMessage({ ok: true, text: tm('common.saved') });
    onSaved(result.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tm('alerts.settingsTitle')}</CardTitle>
      </CardHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{tm('alerts.lowBalance')}</FieldLabel>
          <Input
            name="threshold"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 text-md"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
          <FieldDescription>{tm('alerts.lowBalanceHint')}</FieldDescription>
          <FieldError match={invalid}>{tm('alerts.lowBalanceInvalid')}</FieldError>
        </Field>
        <div className="flex min-h-12 items-center justify-between gap-3">
          <span className="flex flex-col">
            <span id="daily-email">{tm('alerts.dailyEmail')}</span>
            <span className="text-sm text-muted-foreground">{tm('alerts.dailyEmailHint')}</span>
          </span>
          <Switch
            aria-labelledby="daily-email"
            checked={dailyEmail}
            onCheckedChange={setDailyEmail}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="xl" disabled={pending}>
            {tm('common.save')}
          </Button>
          {message &&
            (message.ok ? (
              <span role="status" className="text-sm text-muted-foreground">
                {message.text}
              </span>
            ) : (
              <FormAlert>{message.text}</FormAlert>
            ))}
        </div>
      </form>
    </Card>
  );
}

function EventsCard({
  alerts,
  nextCursor,
  onMore,
}: {
  alerts: MerchantAlert[];
  nextCursor: string | null;
  onMore: (alerts: MerchantAlert[], nextCursor: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function more() {
    setPending(true);
    setFailure(null);
    const result = await getAlerts(nextCursor);
    setPending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    onMore(result.data.items, result.data.nextCursor);
  }

  return (
    <Card data-testid="merchant-alerts">
      <CardHeader>
        <CardTitle>{tm('alerts.eventsTitle')}</CardTitle>
        <CardDescription>{tm('alerts.eventsBody')}</CardDescription>
      </CardHeader>
      {alerts.length === 0 ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <BellOffIcon className="size-5" aria-hidden="true" />
          {tm('alerts.eventsEmpty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex flex-col gap-1 py-3">
              <span className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    alert.kind === 'price_down' || alert.kind === 'back_in_stock'
                      ? 'success'
                      : 'warning'
                  }
                >
                  {tm(`alerts.kinds.${alert.kind}`)}
                </Badge>
                <span className="font-medium">{alert.productNameAr}</span>
                <span className="text-sm text-muted-foreground">{alert.gameNameAr}</span>
              </span>
              {alert.oldPriceUsdUnits !== null && alert.newPriceUsdUnits !== null && (
                <span className="text-sm tabular-nums">
                  {tm('alerts.priceChange', {
                    old: ltr(formatUsd(alert.oldPriceUsdUnits)),
                    new: ltr(formatUsd(alert.newPriceUsdUnits)),
                  })}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {formatDateTime(alert.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      {nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={pending}
          onClick={more}
        >
          {tm('alerts.loadMore')}
        </Button>
      )}
    </Card>
  );
}
