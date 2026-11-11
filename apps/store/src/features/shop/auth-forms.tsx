'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { MailQuestionIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import { PageBackLink } from '@/components/page-back-link';
import { CodeInput } from '@/features/auth/code-input';
import { type CountryCode, DEFAULT_COUNTRY, toE164 } from '@/features/auth/phone';
import { PhoneField } from '@/features/auth/phone-field';
import { useCountdown } from '@/features/auth/use-countdown';
import {
  codeError,
  currentPasswordError,
  emailError,
  nameError,
  newPasswordError,
} from '@/features/auth/validation';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { clearErrorOnInput } from '@/lib/field-errors';
import { t } from '@/lib/i18n';
import { useSearchParam } from '@/lib/use-search-param';
import { ts } from './i18n';
import { shopNext, shopPath } from './paths';
import {
  shopAcceptInvitation,
  shopRequestPasswordReset,
  shopResetPassword,
  shopSendVerificationCode,
  shopSignIn,
  shopSignUp,
  shopVerifyEmail,
} from './requests';
import { refreshShopCustomer } from './session';

/*
 * A shop's account screens (S26 CA1–CA4): S01's forms against the shop's own Better Auth
 * instance, in the shop's frame. The email waiting for its code travels in this tab's session
 * storage, per shop, never in a URL; the password typed with it only in this page's memory.
 */

const pendingKey = (slug: string) => `vertex-shop-pending:${slug}`;
let heldPassword: string | null = null;

type Pending = { email: string; next: string };

function savePending(slug: string, pending: Pending, password: string | null) {
  heldPassword = password;
  try {
    sessionStorage.setItem(pendingKey(slug), JSON.stringify(pending));
  } catch {
    // Unavailable storage: the code page says there is nothing to verify and links back.
  }
}

function readPending(slug: string): Pending | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(pendingKey(slug)) ?? 'null',
    ) as Partial<Pending> | null;
    if (typeof value?.email !== 'string') return null;
    return { email: value.email, next: shopNext(slug, value.next ?? null) };
  } catch {
    return null;
  }
}

function clearPending(slug: string) {
  heldPassword = null;
  try {
    sessionStorage.removeItem(pendingKey(slug));
  } catch {
    // Nothing to clear.
  }
}

/** Signed in: a full load, so everything rendered for a visitor is read again. */
async function enter(slug: string, next: string) {
  await refreshShopCustomer(slug);
  window.location.assign(shopNext(slug, next));
}

function Frame({
  title,
  description,
  back,
  children,
}: {
  title: string;
  description?: string;
  back?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8 md:py-12">
      {back}
      <PageHeader title={title} description={description} />
      <div className="rounded-xl border border-border bg-surface p-5">{children}</div>
    </div>
  );
}

const LINK = 'inline-flex min-h-11 items-center font-medium text-(--shop-brand) hover:underline';

// --- Sign-in (CA4) ---

export function ShopSignIn({
  slug,
  name,
  signUp,
}: {
  slug: string;
  name: string;
  signUp: boolean;
}) {
  const router = useRouter();
  const next = useSearchParam('next');
  const notice = useSearchParam('notice');
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const found = { email: emailError(email), password: currentPasswordError(password) };
    setErrors(found);
    setFailure(null);
    if (found.email || found.password) return focusInvalid();
    setPending(true);
    const result = await shopSignIn(slug, email, password, {
      onVerifying: () => setVerifying(true),
    });
    setVerifying(false);
    if (result.ok) return enter(slug, next ?? '');
    // An unverified account was sent a new code at the sign-in: enter it next.
    if (result.reason === 'EMAIL_NOT_VERIFIED') {
      savePending(slug, { email, next: shopNext(slug, next) }, password);
      router.push(shopPath(slug, '/verify'));
      return;
    }
    setPending(false);
    setFailure(result.reason);
  }

  const query = next ? `?${new URLSearchParams({ next })}` : '';
  return (
    <Frame
      title={ts('auth.signInTitle')}
      description={ts('auth.signInDescription', { name })}
      back={<PageBackLink href={shopPath(slug)}>{ts('back.home')}</PageBackLink>}
    >
      <div className="flex flex-col gap-5">
        {notice === 'password-reset' && (
          <FormAlert tone="success">{ts('auth.resetDone')}</FormAlert>
        )}
        <form
          ref={ref}
          noValidate
          onSubmit={submit}
          onInput={clearErrorOnInput(setErrors)}
          className="flex flex-col gap-5"
        >
          <EmailField error={errors.email} />
          <Field invalid={!!errors.password}>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>{t('fields.password')}</FieldLabel>
              <Link href={`${shopPath(slug, '/reset')}${query}`} className={`${LINK} text-sm`}>
                {ts('auth.forgot')}
              </Link>
            </div>
            <PasswordInput
              name="password"
              autoComplete="current-password"
              className="h-11 text-md"
              showLabel={t('fields.showPassword')}
              hideLabel={t('fields.hidePassword')}
              aria-invalid={!!errors.password}
            />
            <FieldError match={!!errors.password}>{errors.password}</FieldError>
          </Field>
          {failure && (
            <FormAlert>
              {failure === 'INVALID_EMAIL_OR_PASSWORD' ? ts('auth.wrong') : errorText(failure)}
            </FormAlert>
          )}
          <InvalidAlert show={!!(errors.email || errors.password)} />
          <Button type="submit" size="xl" disabled={pending}>
            {verifying
              ? t('signIn.verifying')
              : pending
                ? ts('auth.signingIn')
                : ts('auth.signInSubmit')}
          </Button>
        </form>
        {signUp && (
          <p className="text-center text-sm text-muted-foreground">
            {ts('auth.noAccount')}{' '}
            <Link href={`${shopPath(slug, '/sign-up')}${query}`} className={LINK}>
              {ts('auth.createAccount')}
            </Link>
          </p>
        )}
      </div>
    </Frame>
  );
}

function EmailField({ error }: { error?: string }) {
  return (
    <Field invalid={!!error}>
      <FieldLabel>{t('fields.email')}</FieldLabel>
      <Input
        name="email"
        type="email"
        dir="ltr"
        autoComplete="email"
        inputMode="email"
        className="h-11 text-md"
        aria-invalid={!!error}
      />
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}

// --- Sign-up (CA2, CA3, CA6) ---

type SignUpFields = 'name' | 'email' | 'password' | 'phone' | 'terms';

export function ShopSignUp({
  slug,
  name: shopName,
  accepting,
}: {
  slug: string;
  name: string;
  /** SH6, SH7: only an active shop takes new customers. */
  accepting: boolean;
}) {
  const router = useRouter();
  const next = useSearchParam('next');
  const [country, setCountry] = useState<CountryCode>(DEFAULT_COUNTRY);
  const [phone, setPhone] = useState('');
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [closed, setClosed] = useState(!accepting);
  const [errors, setErrors] = useState<Partial<Record<SignUpFields, string>>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const termsId = useId();
  const back = <PageBackLink href={shopPath(slug, '/sign-in')}>{ts('back.signIn')}</PageBackLink>;

  if (closed) {
    return (
      <Frame title={ts('auth.signUpTitle')} back={back}>
        <FormAlert>{ts('auth.notAccepting')}</FormAlert>
      </Frame>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const e164 = toE164(phone, country);
    const found = {
      name: nameError(name),
      email: emailError(email),
      password: newPasswordError(password, email),
      phone: e164 ? undefined : t('validation.phoneInvalid'),
      terms: terms ? undefined : ts('auth.acceptTermsMissing'),
    };
    setErrors(found);
    setFailure(null);
    if (Object.values(found).some(Boolean) || !e164) return focusInvalid();
    setPending(true);
    const result = await shopSignUp(slug, {
      name,
      email,
      password,
      phone: e164,
      acceptTerms: true,
    });
    if (result.ok) {
      savePending(slug, { email, next: shopNext(slug, next) }, password);
      router.push(shopPath(slug, '/verify'));
      return;
    }
    setPending(false);
    if (result.reason === 'SHOP_CUSTOMER_LIMIT_REACHED' || result.reason === 'SHOP_UNAVAILABLE') {
      return setClosed(true);
    }
    if (result.reason === 'PASSWORD_TOO_COMMON') {
      setErrors({ password: t('validation.passwordCommon') });
      return focusInvalid();
    }
    setFailure(result.reason);
  }

  return (
    <Frame
      title={ts('auth.signUpTitle')}
      description={ts('auth.signUpDescription', { name: shopName })}
      back={back}
    >
      <form
        ref={ref}
        noValidate
        onSubmit={submit}
        onInput={clearErrorOnInput(setErrors)}
        className="flex flex-col gap-5"
      >
        <Field invalid={!!errors.name}>
          <FieldLabel>{t('fields.name')}</FieldLabel>
          <Input
            name="name"
            autoComplete="name"
            className="h-11 text-md"
            aria-invalid={!!errors.name}
          />
          <FieldError match={!!errors.name}>{errors.name}</FieldError>
        </Field>
        <EmailField error={errors.email} />
        <Field invalid={!!errors.password}>
          <FieldLabel>{t('fields.password')}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!errors.password}
          />
          <FieldDescription>{t('fields.passwordHint')}</FieldDescription>
          <FieldError match={!!errors.password}>{errors.password}</FieldError>
        </Field>
        <PhoneField
          country={country}
          onCountryChange={setCountry}
          value={phone}
          onValueChange={setPhone}
          error={errors.phone}
        />
        <Field invalid={!!errors.terms}>
          <label htmlFor={termsId} className="flex min-h-11 cursor-pointer items-center gap-3">
            <Checkbox
              id={termsId}
              checked={terms}
              aria-invalid={!!errors.terms}
              onCheckedChange={(checked) => {
                setTerms(checked);
                setErrors((current) => ({ ...current, terms: undefined }));
              }}
            />
            <span className="text-base">
              <Link href={shopPath(slug, '/terms')} target="_blank" className={LINK}>
                {ts('auth.acceptTerms')}
              </Link>
            </span>
          </label>
          <FieldError match={!!errors.terms}>{errors.terms}</FieldError>
        </Field>
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? ts('auth.signingUp') : ts('auth.signUpSubmit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {ts('auth.haveAccount')}{' '}
          <Link href={shopPath(slug, '/sign-in')} className={LINK}>
            {ts('auth.signInTitle')}
          </Link>
        </p>
      </form>
    </Frame>
  );
}

// --- The email code (CA2) ---

export function ShopVerify({ slug }: { slug: string }) {
  const [pending, setPending] = useState<Pending | null | undefined>(undefined);
  useEffect(() => setPending(readPending(slug)), [slug]);
  const back = <PageBackLink href={shopPath(slug, '/sign-in')}>{ts('back.signIn')}</PageBackLink>;
  if (pending === undefined)
    return (
      <Frame title={ts('auth.verifyTitle')} back={back}>
        {null}
      </Frame>
    );
  if (pending === null) {
    return (
      <Frame title={ts('auth.verifyTitle')} back={back}>
        <EmptyState icon={<MailQuestionIcon />} title={ts('auth.verifyNothing')} />
      </Frame>
    );
  }
  return (
    <Frame
      title={ts('auth.verifyTitle')}
      description={ts('auth.verifyDescription', { email: pending.email })}
      back={back}
    >
      <VerifyForm slug={slug} pending={pending} />
    </Frame>
  );
}

function VerifyForm({ slug, pending }: { slug: string; pending: Pending }) {
  const [code, setCode] = useState('');
  const [codeFailure, setCodeFailure] = useState<string | undefined>();
  const [held] = useState(() => heldPassword);
  const [passwordFailure, setPasswordFailure] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const countdown = useCountdown(60);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = held ?? String(new FormData(event.currentTarget).get('password') ?? '');
    const invalid = codeError(code);
    const passwordInvalid = held ? undefined : currentPasswordError(password);
    setCodeFailure(invalid);
    setPasswordFailure(passwordInvalid);
    setFailure(null);
    if (invalid || passwordInvalid) return focusInvalid();
    setSubmitting(true);
    const result = await shopVerifyEmail(slug, { email: pending.email, otp: code, password });
    if (result.ok) {
      clearPending(slug);
      return enter(slug, pending.next);
    }
    setSubmitting(false);
    setFailure(result.reason);
  }

  async function resend() {
    setResending(true);
    setNotice(false);
    setFailure(null);
    const result = await shopSendVerificationCode(slug, pending.email);
    setResending(false);
    if (!result.ok) return setFailure(result.reason);
    setNotice(true);
    countdown.restart();
  }

  return (
    <form ref={ref} noValidate onSubmit={submit} className="flex flex-col gap-5">
      <CodeInput value={code} onValueChange={setCode} error={codeFailure} autoFocus />
      {!held && (
        <Field invalid={!!passwordFailure}>
          <FieldLabel>{t('fields.password')}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!passwordFailure}
          />
          <FieldError match={!!passwordFailure}>{passwordFailure}</FieldError>
        </Field>
      )}
      {notice && <FormAlert tone="success">{ts('auth.resent')}</FormAlert>}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <Button type="submit" size="xl" disabled={submitting}>
        {submitting ? ts('auth.verifying') : ts('auth.verifySubmit')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xl"
        disabled={resending || countdown.left > 0}
        onClick={() => void resend()}
      >
        {countdown.left > 0 ? ts('auth.resendIn', { seconds: countdown.left }) : ts('auth.resend')}
      </Button>
    </form>
  );
}

// --- Password reset (CA4) ---

export function ShopReset({ slug }: { slug: string }) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ email?: string; code?: string; password?: string }>({});
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const back = <PageBackLink href={shopPath(slug, '/sign-in')}>{ts('back.signIn')}</PageBackLink>;

  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    const found = emailError(typed);
    setErrors({ email: found });
    setFailure(null);
    if (found) return focusInvalid();
    setPending(true);
    const result = await shopRequestPasswordReset(slug, typed);
    setPending(false);
    if (!result.ok) return setFailure(result.reason);
    setEmail(typed);
  }

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email) return;
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    const found = { code: codeError(code), password: newPasswordError(password, email) };
    setErrors(found);
    setFailure(null);
    if (found.code || found.password) return focusInvalid();
    setPending(true);
    const result = await shopResetPassword(slug, { email, otp: code, password });
    if (result.ok) {
      router.push(`${shopPath(slug, '/sign-in')}?notice=password-reset`);
      return;
    }
    setPending(false);
    setFailure(result.reason);
  }

  return (
    <Frame title={ts('auth.resetTitle')} description={ts('auth.resetDescription')} back={back}>
      {email === null ? (
        <form ref={ref} noValidate onSubmit={request} className="flex flex-col gap-5">
          <EmailField error={errors.email} />
          {failure && <FormAlert>{errorText(failure)}</FormAlert>}
          <Button type="submit" size="xl" disabled={pending}>
            {pending ? ts('auth.resetSending') : ts('auth.resetSend')}
          </Button>
        </form>
      ) : (
        <form ref={ref} noValidate onSubmit={reset} className="flex flex-col gap-5">
          <FormAlert tone="success">{ts('auth.resetSent')}</FormAlert>
          <CodeInput value={code} onValueChange={setCode} error={errors.code} autoFocus />
          <Field invalid={!!errors.password}>
            <FieldLabel>{ts('auth.newPassword')}</FieldLabel>
            <PasswordInput
              name="password"
              autoComplete="new-password"
              className="h-11 text-md"
              showLabel={t('fields.showPassword')}
              hideLabel={t('fields.hidePassword')}
              aria-invalid={!!errors.password}
            />
            <FieldDescription>{t('fields.passwordHint')}</FieldDescription>
            <FieldError match={!!errors.password}>{errors.password}</FieldError>
          </Field>
          {failure && <FormAlert>{errorText(failure)}</FormAlert>}
          <InvalidAlert show={!!(errors.code || errors.password)} />
          <Button type="submit" size="xl" disabled={pending}>
            {pending ? ts('auth.resetSaving') : ts('auth.resetSubmit')}
          </Button>
        </form>
      )}
    </Frame>
  );
}

// --- The invitation (CA1) ---

export function ShopInvite({ slug, name, token }: { slug: string; name: string; token: string }) {
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    const found = newPasswordError(password);
    setError(found);
    setFailure(null);
    if (found) return focusInvalid();
    setPending(true);
    const result = await shopAcceptInvitation(slug, { token, password });
    if (result.ok) return enter(slug, '');
    setPending(false);
    setFailure(result.reason);
  }

  return (
    <Frame title={ts('auth.inviteTitle', { name })} description={ts('auth.inviteDescription')}>
      <form ref={ref} noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Field invalid={!!error}>
          <FieldLabel>{ts('auth.newPassword')}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            className="h-11 text-md"
            showLabel={t('fields.showPassword')}
            hideLabel={t('fields.hidePassword')}
            aria-invalid={!!error}
          />
          <FieldDescription>{t('fields.passwordHint')}</FieldDescription>
          <FieldError match={!!error}>{error}</FieldError>
        </Field>
        {failure && (
          <FormAlert>
            {failure === 'INVALID_OTP' || failure === 'VALIDATION_FAILED'
              ? ts('auth.inviteInvalid')
              : errorText(failure)}
          </FormAlert>
        )}
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? ts('auth.inviteSaving') : ts('auth.inviteSubmit')}
        </Button>
      </form>
    </Frame>
  );
}
