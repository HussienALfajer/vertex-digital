'use client';

import type { CustomerProfile, UpdateCustomerProfile } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { countryOf, formatPhone, nationalPhone, toE164 } from '../auth/phone';
import { PhoneField } from '../auth/phone-field';
import { focusFirst, nameError } from '../auth/validation';
import { updateProfile } from './requests';

/** Name and phone, editable at any time (rule C13); the email changes on its own page. */
export function ProfileCard({
  profile,
  onSaved,
}: {
  profile: CustomerProfile;
  onSaved: (profile: CustomerProfile) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('account.profile.title')}</CardTitle>
          <CardDescription>
            {t('account.profile.memberSince', { date: formatDate(profile.createdAt) })}
          </CardDescription>
        </div>
        {!editing && (
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            {t('account.profile.edit')}
          </Button>
        )}
      </CardHeader>
      {editing ? (
        <ProfileForm
          profile={profile}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            setSaved(true);
            onSaved(next);
          }}
        />
      ) : (
        <dl className="flex flex-col gap-4">
          <Row label={t('fields.name')}>{profile.name}</Row>
          <Row label={t('fields.email')}>
            <div className="flex items-center justify-between gap-2">
              <span dir="ltr" className="break-all">
                {profile.email}
              </span>
              <Button variant="ghost" size="xl" render={<Link href="/account/email" />}>
                {t('account.profile.changeEmail')}
              </Button>
            </div>
          </Row>
          <Row label={t('fields.phone')}>
            <span dir="ltr">{formatPhone(profile.phone)}</span>
          </Row>
        </dl>
      )}
      {saved && <FormAlert tone="success">{t('account.profile.saved')}</FormAlert>}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium">{children}</dd>
    </div>
  );
}

function ProfileForm({
  profile,
  onCancel,
  onSaved,
}: {
  profile: CustomerProfile;
  onCancel: () => void;
  onSaved: (profile: CustomerProfile) => void;
}) {
  const [country, setCountry] = useState(() => countryOf(profile.phone));
  const [phone, setPhone] = useState(() => nationalPhone(profile.phone));
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    const e164 = toE164(phone, country);
    const found = {
      name: nameError(name),
      phone: e164 ? undefined : t('validation.phoneInvalid'),
    };
    setErrors(found);
    setFailure(null);
    if (found.name || found.phone || !e164) {
      focusFirst(form, found);
      return;
    }
    // Only what changed, so the audit entry names it (rule C13).
    const changes: UpdateCustomerProfile = {};
    if (name !== profile.name) changes.name = name;
    if (e164 !== profile.phone) changes.phone = e164;
    if (!changes.name && !changes.phone) return onCancel();
    setPending(true);
    const result = await updateProfile(changes);
    setPending(false);
    if (result.ok) onSaved(result.data);
    else setFailure(result.reason);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      <Field invalid={!!errors.name}>
        <FieldLabel>{t('fields.name')}</FieldLabel>
        <Input
          name="name"
          autoComplete="name"
          defaultValue={profile.name}
          className="h-11 text-md"
          aria-invalid={!!errors.name}
        />
        <FieldError match={!!errors.name}>{errors.name}</FieldError>
      </Field>
      <PhoneField
        country={country}
        onCountryChange={setCountry}
        value={phone}
        onValueChange={setPhone}
        error={errors.phone}
      />
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="xl" disabled={pending}>
          {pending ? t('account.profile.saving') : t('account.profile.save')}
        </Button>
        <Button variant="ghost" size="xl" onClick={onCancel} disabled={pending}>
          {t('account.profile.cancel')}
        </Button>
      </div>
    </form>
  );
}
