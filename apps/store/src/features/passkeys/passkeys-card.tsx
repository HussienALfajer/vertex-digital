'use client';

import { PASSKEYS_MAX, type Passkey, passkeyNameSchema } from '@vertex-digital/contracts';
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
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { FingerprintIcon } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { currentPasswordError } from '../auth/validation';
import { tp } from './i18n';
import {
  authorizePasskey,
  type CeremonyFailure,
  listPasskeys,
  passkeysSupported,
  registerPasskey,
  removePasskey,
  renamePasskey,
} from './requests';

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; items: Passkey[] };

/** What the card says after an action. */
type Note = { tone: 'success' | 'error'; text: string } | null;

const failureText = (reason: CeremonyFailure) =>
  reason === 'CANCELLED'
    ? tp('card.cancelled')
    : reason === 'ALREADY_REGISTERED'
      ? tp('card.already')
      : reason === 'UNKNOWN'
        ? tp('card.failed')
        : errorText(reason);

/**
 * "الدخول بالبصمة" on the account page (S22 PK2, PK4): the passkeys with when they were added and
 * last used, "أضف بصمة" (the password first, then the browser's prompt; hidden without WebAuthn),
 * rename and remove with a confirmation. Loaded with `next/dynamic` by the account page.
 */
export function PasskeysCard() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [supported, setSupported] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  const load = useCallback(async () => {
    const result = await listPasskeys();
    setState(result.ok ? { status: 'ready', items: result.data } : { status: 'failed' });
  }, []);

  useEffect(() => {
    setSupported(passkeysSupported());
    void load();
  }, [load]);

  /** After the password: the browser's prompt, then the list again. */
  const add = async () => {
    setAdding(true);
    const result = await registerPasskey();
    setAdding(false);
    if (result.ok) {
      setNote({ tone: 'success', text: tp('card.added', { name: result.data.name }) });
      return load();
    }
    // The 5 minutes ran out between the password and the prompt: ask for it again.
    if (result.reason === 'REAUTHENTICATION_REQUIRED') return setAuthorizing(true);
    setNote({ tone: 'error', text: failureText(result.reason) });
  };

  if (state.status === 'loading') {
    return (
      <Card aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-11 w-full" />
      </Card>
    );
  }

  const items = state.status === 'ready' ? state.items : [];
  const full = items.length >= PASSKEYS_MAX;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tp('card.title')}</CardTitle>
        <CardDescription>{tp('card.description')}</CardDescription>
      </CardHeader>
      {state.status === 'failed' ? (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{tp('card.loadFailed')}</FormAlert>
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {tp('card.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{tp('card.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
            >
              <div className="flex min-w-0 items-start gap-3">
                <FingerprintIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Text only: a name is the customer's own words. */}
                    <span className="font-medium break-words">{passkey.name}</span>
                    <Badge tone={passkey.backedUp ? 'success' : 'neutral'}>
                      {passkey.backedUp ? tp('card.synced') : tp('card.deviceOnly')}
                    </Badge>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {tp('card.createdAt', { date: formatDate(passkey.createdAt) })}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {passkey.lastUsedAt
                      ? tp('card.lastUsed', { date: formatDate(passkey.lastUsedAt) })
                      : tp('card.neverUsed')}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="xl"
                  aria-label={tp('card.renameLabel', { name: passkey.name })}
                  onClick={() => setRenaming(passkey)}
                >
                  {tp('card.rename')}
                </Button>
                <Button
                  variant="outline"
                  size="xl"
                  aria-label={tp('card.removeLabel', { name: passkey.name })}
                  onClick={() => setRemoving(passkey)}
                >
                  {tp('card.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <FormAlert tone={note.tone === 'success' ? 'success' : undefined}>{note.text}</FormAlert>
      )}
      {!supported ? (
        <p className="text-sm text-muted-foreground">{tp('card.unsupported')}</p>
      ) : full ? (
        <p className="text-sm text-muted-foreground">{tp('card.limit', { max: PASSKEYS_MAX })}</p>
      ) : (
        state.status === 'ready' && (
          <Button
            size="xl"
            className="self-start"
            disabled={adding}
            onClick={() => {
              setNote(null);
              setAuthorizing(true);
            }}
          >
            <FingerprintIcon />
            {adding ? tp('card.adding') : tp('card.add')}
          </Button>
        )
      )}
      <AuthorizeDialog
        open={authorizing}
        onOpenChange={setAuthorizing}
        onAuthorized={() => {
          setAuthorizing(false);
          void add();
        }}
      />
      {renaming && (
        <RenameDialog
          passkey={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(renamed) => {
            setRenaming(null);
            setState((previous) =>
              previous.status === 'ready'
                ? {
                    ...previous,
                    items: previous.items.map((item) => (item.id === renamed.id ? renamed : item)),
                  }
                : previous,
            );
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          passkey={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            setState((previous) =>
              previous.status === 'ready'
                ? { ...previous, items: previous.items.filter((item) => item.id !== removing.id) }
                : previous,
            );
          }}
        />
      )}
    </Card>
  );
}

/** PK2: the account password, which opens this session's registration for 5 minutes. */
function AuthorizeDialog({
  open,
  onOpenChange,
  onAuthorized,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthorized: () => void;
}) {
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    const found = currentPasswordError(password);
    setError(found);
    if (found) return focusInvalid();
    setPending(true);
    const result = await authorizePasskey(password);
    setPending(false);
    if (result.ok) return onAuthorized();
    setError(errorText(result.reason));
    focusInvalid();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent closeLabel={tp('authorize.cancel')}>
        <DialogHeader>
          <DialogTitle>{tp('authorize.title')}</DialogTitle>
          <DialogDescription>{tp('authorize.description')}</DialogDescription>
        </DialogHeader>
        <form ref={ref} noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
          <Field invalid={!!error}>
            <FieldLabel>{t('fields.currentPassword')}</FieldLabel>
            <PasswordInput
              name="password"
              autoComplete="current-password"
              className="h-11 text-md"
              showLabel={t('fields.showPassword')}
              hideLabel={t('fields.hidePassword')}
              aria-invalid={!!error}
            />
            <FieldError match={!!error}>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="xl" />}>
              {tp('authorize.cancel')}
            </DialogClose>
            <Button type="submit" size="xl" disabled={pending}>
              {pending ? tp('authorize.submitting') : tp('authorize.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** PK4: a new name, checked by the contracts' rule. */
function RenameDialog({
  passkey,
  onClose,
  onRenamed,
}: {
  passkey: Passkey;
  onClose: () => void;
  onRenamed: (passkey: Passkey) => void;
}) {
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = passkeyNameSchema.safeParse(
      String(new FormData(event.currentTarget).get('name') ?? ''),
    );
    if (!parsed.success) {
      setError(tp('rename.invalid'));
      return focusInvalid();
    }
    setPending(true);
    const result = await renamePasskey(passkey.id, parsed.data);
    setPending(false);
    if (result.ok) return onRenamed(result.data);
    setError(
      result.reason === 'VALIDATION_FAILED' ? tp('rename.invalid') : errorText(result.reason),
    );
    focusInvalid();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={tp('rename.cancel')}>
        <DialogHeader>
          <DialogTitle>{tp('rename.title')}</DialogTitle>
        </DialogHeader>
        <form ref={ref} noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
          <Field invalid={!!error}>
            <FieldLabel>{tp('rename.label')}</FieldLabel>
            <Input
              name="name"
              defaultValue={passkey.name}
              maxLength={40}
              className="h-11 text-md"
              aria-invalid={!!error}
            />
            <FieldDescription>{tp('rename.hint')}</FieldDescription>
            <FieldError match={!!error}>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="xl" />}>
              {tp('rename.cancel')}
            </DialogClose>
            <Button type="submit" size="xl" disabled={pending}>
              {pending ? tp('rename.submitting') : tp('rename.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** PK4: removal with a confirmation, no password. */
function RemoveDialog({
  passkey,
  onClose,
  onRemoved,
}: {
  passkey: Passkey;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const remove = async () => {
    setPending(true);
    const result = await removePasskey(passkey.id);
    setPending(false);
    if (result.ok || result.reason === 'NOT_FOUND') return onRemoved();
    setFailure(errorText(result.reason));
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tp('remove.title', { name: passkey.name })}</AlertDialogTitle>
          <AlertDialogDescription>{tp('remove.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure && <FormAlert>{failure}</FormAlert>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="xl" />}>
            {tp('remove.cancel')}
          </AlertDialogClose>
          <Button variant="destructive" size="xl" disabled={pending} onClick={remove}>
            {pending ? tp('remove.removing') : tp('remove.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
