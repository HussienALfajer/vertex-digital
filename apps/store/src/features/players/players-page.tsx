'use client';

import {
  maskFieldValue,
  type SavedPlayer,
  savedPlayerLabelSchema,
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
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Input } from '@vertex-digital/ui/components/input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  CircleAlertIcon,
  IdCardIcon,
  PackageIcon,
  PencilIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import { deleteSavedPlayer, listSavedPlayers, renameSavedPlayer } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; players: SavedPlayer[] };

/** The saved IDs by game, each group in the order of its newest used ID (rule SP5). */
function byGame(players: SavedPlayer[]): SavedPlayer[][] {
  const groups = new Map<string, SavedPlayer[]>();
  for (const player of players) {
    const group = groups.get(player.gameId) ?? [];
    group.push(player);
    groups.set(player.gameId, group);
  }
  return [...groups.values()];
}

/** The first value of the game's current fields (else any), masked (rule SH3). */
function mainValue(player: SavedPlayer): string | null {
  const key = Object.keys(player.fieldLabels).find((item) => player.fields[item]);
  const value = key ? player.fields[key] : Object.values(player.fields)[0];
  return value ? maskFieldValue(value) : null;
}

/**
 * "معرّفاتي" (S10 rule SP5): the customer's saved player IDs grouped by game, newest used first,
 * with "اشحن" (the game with the ID chosen), an inline rename and a delete after a confirmation.
 * IDs are saved from the buy box only. Read in the browser with the session, never cached.
 */
export function PlayersPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    const result = await listSavedPlayers();
    if (!result.ok && result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent('/account/players')}`);
      return;
    }
    setState(result.ok ? { status: 'ready', players: result.data.items } : { status: 'failed' });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <PlayersSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('players.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('players.retry')}
          </Button>
        }
      />
    );
  }
  if (state.players.length === 0) {
    return (
      <EmptyState
        icon={<IdCardIcon />}
        title={t('players.emptyTitle')}
        description={t('players.emptyBody')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {t('players.browse')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {byGame(state.players).map((group) => {
        const first = group[0] as SavedPlayer;
        return (
          <Card key={first.gameId} className="gap-3">
            <div className="flex items-center gap-3">
              {first.cover ? (
                // biome-ignore lint/performance/noImgElement: catalog images are stored re-encoded and served immutable by the API (S06).
                <img
                  src={`${first.cover.url}?w=160`}
                  alt=""
                  width={first.cover.width}
                  height={first.cover.height}
                  className="size-12 shrink-0 rounded-md object-cover"
                />
              ) : (
                <IconTile tone="muted">
                  <PackageIcon />
                </IconTile>
              )}
              <h2 className="text-lg font-bold">{first.gameNameAr}</h2>
              {!first.gameShown && <Badge tone="neutral">{t('players.unavailable')}</Badge>}
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {group.map((player) => (
                <li key={player.id} className="py-3">
                  <PlayerRow player={player} onChange={load} />
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function PlayerRow({ player, onChange }: { player: SavedPlayer; onChange: () => Promise<void> }) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(player.label);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const value = mainValue(player);
  const labelValid = savedPlayerLabelSchema.safeParse(label).success;

  async function rename() {
    if (!labelValid) return;
    setFailure(null);
    setBusy(true);
    const result = await renameSavedPlayer(player.id, label.trim());
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    setRenaming(false);
    await onChange();
  }

  async function remove() {
    setFailure(null);
    setBusy(true);
    const result = await deleteSavedPlayer(player.id);
    setBusy(false);
    setDeleting(false);
    if (!result.ok) return setFailure(result.reason);
    await onChange();
  }

  return (
    <div className="flex flex-col gap-3">
      {renaming ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <Field invalid={!labelValid}>
            <FieldLabel>{t('players.label')}</FieldLabel>
            <Input
              value={label}
              maxLength={40}
              autoComplete="off"
              className="h-11 text-md"
              aria-invalid={!labelValid}
              onChange={(event) => setLabel(event.target.value)}
            />
            <FieldError match={!labelValid}>{t('purchase.save.labelInvalid')}</FieldError>
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="xl" disabled={busy || !labelValid}>
              {t('players.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xl"
              onClick={() => {
                setLabel(player.label);
                setRenaming(false);
              }}
            >
              {t('players.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-bold break-words">
              <bdi>{player.label}</bdi>
            </p>
            <p className="text-sm text-muted-foreground">
              {value && <bdi dir="ltr">{value}</bdi>}
              {player.playerName && (
                <>
                  {value && ' · '}
                  <bdi>{player.playerName}</bdi>
                </>
              )}
            </p>
            {player.lastUsedAt && (
              <p className="text-xs text-muted-foreground">
                {t('players.lastUsed', { when: formatRelative(player.lastUsedAt) })}
              </p>
            )}
            {player.rejected && (
              <p className="flex items-center gap-1 text-xs text-status-warning-foreground">
                <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                {t('purchase.saved.rejectedShort')}
              </p>
            )}
          </div>
          {player.gameShown ? (
            <Button
              size="xl"
              render={
                <Link
                  href={`/games/${encodeURIComponent(player.gameSlug)}?${new URLSearchParams({
                    player: player.id,
                  })}`}
                />
              }
            >
              {t('players.topUp')}
            </Button>
          ) : (
            <Button size="xl" disabled>
              {t('players.topUp')}
            </Button>
          )}
        </div>
      )}
      {!renaming && (
        <div className="flex gap-2">
          <Button variant="ghost" size="xl" className="px-3" onClick={() => setRenaming(true)}>
            <PencilIcon aria-hidden="true" />
            {t('players.rename')}
          </Button>
          <Button
            variant="ghost"
            size="xl"
            className="px-3 text-destructive-text"
            onClick={() => setDeleting(true)}
          >
            <Trash2Icon aria-hidden="true" />
            {t('players.delete')}
          </Button>
        </div>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('players.deleteTitle', { label: player.label })}</AlertDialogTitle>
            <AlertDialogDescription>{t('players.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('players.keep')}
            </AlertDialogClose>
            <Button variant="destructive" size="xl" disabled={busy} onClick={() => void remove()}>
              {t('players.deleteConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PlayersSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {[0, 1].map((row) => (
        <Skeleton key={row} className="h-44 w-full" />
      ))}
    </div>
  );
}
