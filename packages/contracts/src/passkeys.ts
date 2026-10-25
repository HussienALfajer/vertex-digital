import { z } from 'zod';
import type { DeviceDescription } from './user-agent.js';

/*
 * Customer passkeys (S22 F40, ADR 0037), owned by the api `auth` module: a second way for a
 * customer to sign in, added with the account password. The admin never has passkeys (ADR 0016).
 */

/** Rule PK2: at most this many passkeys per account. */
export const PASSKEYS_MAX = 10;

/** Rule PK2: the password opens this session's registration window for 5 minutes. */
export const PASSKEY_GRANT_SECONDS = 5 * 60;

/** A WebAuthn ceremony (options to verification) must end within 5 minutes. */
export const PASSKEY_CHALLENGE_SECONDS = 5 * 60;

/** The verification row that holds a session's registration grant (rule PK2). */
export function passkeyGrantIdentifier(sessionId: string): string {
  return `passkey-grant:${sessionId}`;
}

/** A passkey's name: 1–40 printable characters, trimmed, no bidi or format controls (rule PK4). */
export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{C}]+$/u, 'Expected printable characters only');

/** The stored name when the device names neither its system nor its browser. */
export const PASSKEY_FALLBACK_NAME = 'بصمة';

/**
 * Rule PK2: the default name, the system and the browser the device names ("iOS · Safari"); a
 * part `describeUserAgent` could not name is left out.
 */
export function defaultPasskeyName(device: DeviceDescription): string {
  const parts = [device.system, device.browser].filter((part) => part !== 'Unknown');
  return parts.length > 0 ? parts.join(' · ') : PASSKEY_FALLBACK_NAME;
}

/** `singleDevice`: kept on one device; `multiDevice`: synced (WebAuthn's credential device type). */
export const PASSKEY_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;

export const passkeyDeviceTypeSchema = z
  .enum(PASSKEY_DEVICE_TYPES)
  .meta({ id: 'PasskeyDeviceType' });

export type PasskeyDeviceType = z.infer<typeof passkeyDeviceTypeSchema>;

/** One passkey, on the account page (rule PK4) and in the admin's devices tab (rule PK6). */
export const passkeySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    deviceType: passkeyDeviceTypeSchema,
    backedUp: z.boolean(),
  })
  .meta({ id: 'Passkey' });

export type Passkey = z.infer<typeof passkeySchema>;

export const passkeyListSchema = z.array(passkeySchema).meta({ id: 'PasskeyList' });

/** `POST /api/account/passkeys/authorize` (rule PK2). */
export const authorizePasskeySchema = z
  // Bounded like every password (128): scrypt never runs on an oversized body.
  .object({ password: z.string().min(1).max(128) })
  .meta({ id: 'AuthorizePasskey' });

export type AuthorizePasskey = z.infer<typeof authorizePasskeySchema>;

/** `PATCH /api/account/passkeys/:id` (rule PK4). */
export const renamePasskeySchema = z
  .object({ name: passkeyNameSchema })
  .meta({ id: 'RenamePasskey' });

export type RenamePasskey = z.input<typeof renamePasskeySchema>;
