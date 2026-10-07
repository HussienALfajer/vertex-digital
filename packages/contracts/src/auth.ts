import { z } from 'zod';

/*
 * Sign-in forms (ADR 0007), owned by the api `auth` (customers) and `staff` modules. Better Auth
 * checks the credentials; these schemas only shape what the forms send.
 */

/** Email and password. Password rules apply where passwords are set, not at sign-in. */
export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export type SignIn = z.infer<typeof signInSchema>;

/** The 6-digit code of an authenticator app (staff TOTP). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/**
 * A staff backup code as written down: `xxxxx-xxxxx` from the API's alphabet (no look-alikes).
 * Spaces around it and capital letters are forgiven, since codes are typed by hand.
 */
export const backupCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
