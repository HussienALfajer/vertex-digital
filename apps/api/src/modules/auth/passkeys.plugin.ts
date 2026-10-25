import { randomBytes } from 'node:crypto';
import * as Sentry from '@sentry/nestjs';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { PASSKEY_CHALLENGE_SECONDS } from '@vertex-digital/contracts';
import { BASE_ERROR_CODES, type BetterAuthPlugin, type GenericEndpointContext } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { Env } from '../../core/config/env.js';
import type { AuthAccountService } from './auth-account.service.js';
import { metaOf, toApiError } from './auth-endpoints.js';
import type { AuthPasskeysService } from './auth-passkeys.service.js';

/*
 * Customer passkeys (S22 PK1–PK3, ADR 0037): the WebAuthn ceremonies as Better Auth endpoints of
 * the customer instance only, so a passkey session is made and set like every other session and
 * goes through the same hooks (C15, the sign-in log). Built on SimpleWebAuthn, as Better Auth's
 * own passkey plugin is, with what that plugin leaves out: user verification required at both
 * ceremonies, the password grant and the limit before a registration, the row, its audit entry and
 * its email in one transaction, and a counter that goes backwards refused and reported (A13).
 *
 * A ceremony's challenge is a verification row named by a random token in a signed cookie, used
 * once and only for the ceremony that made it, 5 minutes at most.
 */

export const PASSKEY_PATHS = {
  registerOptions: '/passkey/register-options',
  register: '/passkey/register',
  signInOptions: '/passkey/sign-in-options',
  signIn: '/sign-in/passkey',
} as const;

/** Per address, a minute (C8 for the sign-in; the options are asked on every sign-in page). */
export const PASSKEY_RATE_LIMITS = {
  [PASSKEY_PATHS.registerOptions]: 10,
  [PASSKEY_PATHS.register]: 10,
  [PASSKEY_PATHS.signInOptions]: 30,
  [PASSKEY_PATHS.signIn]: 10,
} as const;

const CHALLENGE_COOKIE = 'passkey_challenge';
const CEREMONY_TIMEOUT_MS = 60_000;

type Challenge =
  | { ceremony: 'registration'; challenge: string; customerId: string; sessionId: string }
  | { ceremony: 'authentication'; challenge: string };

const challengeIdentifier = (token: string) => `passkey-challenge:${token}`;

async function storeChallenge(ctx: GenericEndpointContext, challenge: Challenge): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const cookie = ctx.context.createAuthCookie(CHALLENGE_COOKIE, {
    maxAge: PASSKEY_CHALLENGE_SECONDS,
  });
  await ctx.setSignedCookie(cookie.name, token, ctx.context.secret, cookie.attributes);
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: challengeIdentifier(token),
    value: JSON.stringify(challenge),
    expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_SECONDS * 1000),
  });
}

/** The cookie's challenge, deleted as it is read; null when missing, expired or of the other ceremony. */
async function takeChallenge<Ceremony extends Challenge['ceremony']>(
  ctx: GenericEndpointContext,
  ceremony: Ceremony,
): Promise<Extract<Challenge, { ceremony: Ceremony }> | null> {
  const cookie = ctx.context.createAuthCookie(CHALLENGE_COOKIE);
  const token = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!token) return null;
  const row = await ctx.context.internalAdapter.consumeVerificationValue(
    challengeIdentifier(token),
  );
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  const challenge = JSON.parse(row.value) as Challenge;
  return challenge.ceremony === ceremony
    ? (challenge as Extract<Challenge, { ceremony: Ceremony }>)
    : null;
}

const invalidCeremony = () =>
  new APIError('BAD_REQUEST', { code: 'VALIDATION_FAILED', message: 'The passkey is not valid' });

/** Every refused passkey sign-in answers as a refused password sign-in (edge case 20). */
const signInRefused = () =>
  APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);

const ceremonyBody = z.object({ response: z.record(z.string(), z.unknown()) });

export const passkeysPlugin = (
  passkeys: AuthPasskeysService,
  accounts: AuthAccountService,
  env: Env,
) => {
  const origin = env.STORE_URL;
  // PK1: the store's host. Browsers refuse an IP address here: test on `localhost`.
  const rpID = new URL(env.STORE_URL).hostname;

  return {
    id: 'vertex-passkeys',
    endpoints: {
      passkeyRegisterOptions: createAuthEndpoint(
        PASSKEY_PATHS.registerOptions,
        { method: 'POST', use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const holder = { id: user.id, email: user.email, sessionId: session.id };
          let registered: string[];
          try {
            registered = await passkeys.assertCanRegister(holder);
          } catch (error) {
            throw toApiError(error);
          }
          const options = await generateRegistrationOptions({
            rpName: 'Vertex Digital',
            rpID,
            userID: new TextEncoder().encode(user.id),
            userName: user.email,
            userDisplayName: user.name,
            attestationType: 'none',
            excludeCredentials: registered.map((id) => ({ id })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            timeout: CEREMONY_TIMEOUT_MS,
          });
          await storeChallenge(ctx, {
            ceremony: 'registration',
            challenge: options.challenge,
            customerId: user.id,
            sessionId: session.id,
          });
          return ctx.json(options);
        },
      ),
      passkeyRegister: createAuthEndpoint(
        PASSKEY_PATHS.register,
        { method: 'POST', use: [sessionMiddleware], body: ceremonyBody },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const challenge = await takeChallenge(ctx, 'registration');
          if (
            !challenge ||
            challenge.customerId !== user.id ||
            challenge.sessionId !== session.id
          ) {
            throw invalidCeremony();
          }
          const verification = await verifyRegistrationResponse({
            response: ctx.body.response as unknown as RegistrationResponseJSON,
            expectedChallenge: challenge.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: true,
          }).catch(() => null);
          if (!verification?.verified || !verification.registrationInfo) throw invalidCeremony();
          const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
            verification.registrationInfo;
          try {
            const added = await passkeys.register(
              { id: user.id, email: user.email, sessionId: session.id },
              {
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString('base64'),
                counter: credential.counter,
                deviceType: credentialDeviceType,
                backedUp: credentialBackedUp,
                transports: credential.transports?.join(',') || null,
                aaguid: aaguid || null,
              },
              metaOf(ctx.headers),
            );
            return ctx.json(added);
          } catch (error) {
            throw toApiError(error);
          }
        },
      ),
      passkeySignInOptions: createAuthEndpoint(
        PASSKEY_PATHS.signInOptions,
        { method: 'POST' },
        async (ctx) => {
          // No allowed list: the browser offers the store's passkeys it holds (autofill too).
          const options = await generateAuthenticationOptions({
            rpID,
            userVerification: 'required',
            timeout: CEREMONY_TIMEOUT_MS,
          });
          await storeChallenge(ctx, { ceremony: 'authentication', challenge: options.challenge });
          return ctx.json(options);
        },
      ),
      passkeySignIn: createAuthEndpoint(
        PASSKEY_PATHS.signIn,
        { method: 'POST', body: ceremonyBody },
        async (ctx) => {
          const challenge = await takeChallenge(ctx, 'authentication');
          if (!challenge) throw signInRefused();
          const response = ctx.body.response as unknown as AuthenticationResponseJSON;
          const passkey =
            typeof response.id === 'string' ? await passkeys.byCredential(response.id) : null;
          if (!passkey) throw signInRefused();
          const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: challenge.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
              id: response.id,
              publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
              // The counter is checked by `recordUse` once the signature is proven, so a forged
              // assertion can never raise the alert.
              counter: 0,
            },
            requireUserVerification: true,
          }).catch(() => null);
          if (!verification?.verified) throw signInRefused();
          const use = await passkeys.recordUse(passkey, verification.authenticationInfo.newCounter);
          if (use === 'regressed') {
            // PK3: a signature counter that did not go up is a cloned authenticator (A13).
            const error = new Error(`Passkey ${passkey.id}: the signature counter did not go up`);
            ctx.context.logger.error(error.message);
            Sentry.captureException(error);
          }
          if (use !== 'used') throw signInRefused();
          // The session hooks refuse an archived customer (C15) and log the sign-in (S12).
          const created = await ctx.context.internalAdapter.createSession(passkey.customerId);
          if (!created) throw signInRefused();
          // A reset that took the passkey while the session was made: no session (PK5).
          if (!(await passkeys.stillHeld(passkey.id))) {
            await ctx.context.internalAdapter.deleteSession(created.token);
            throw signInRefused();
          }
          const user = await ctx.context.internalAdapter.findUserById(passkey.customerId);
          if (!user) throw signInRefused();
          await setSessionCookie(ctx, { session: created, user });
          // C10: every sign-in sends the new sign-in email.
          await accounts.sendSignInNotice(user, created);
          return ctx.json({
            status: true,
            user: { id: user.id, name: user.name, email: user.email },
          });
        },
      ),
    },
    rateLimit: Object.entries(PASSKEY_RATE_LIMITS).map(([path, max]) => ({
      pathMatcher: (requested: string) => requested === path,
      window: 60,
      max,
    })),
  } satisfies BetterAuthPlugin;
};
