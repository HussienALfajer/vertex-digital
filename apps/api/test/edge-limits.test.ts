import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_AUTH_NEST_PATHS } from '../src/modules/auth/index.js';
import { PASSKEY_PATHS } from '../src/modules/auth/passkeys.plugin.js';

/*
 * ADR 0008: every route that checks a password or a code, sends a code, or stores a passkey
 * challenge sits in nginx's tight auth zone (`vdsignin`) on its host, on top of the API's own
 * limits. Read from the sites in `deploy/nginx`, so a new route that misses the zone fails here
 * (audit A01-2: the passkey routes had).
 */

/** The regex locations of a site that use the auth zone, as JavaScript patterns. */
function authZonePatterns(site: string): RegExp[] {
  const text = readFileSync(new URL(`../../../deploy/nginx/${site}`, import.meta.url), 'utf8');
  const patterns: RegExp[] = [];
  for (const block of text.matchAll(/location ~\*\s+("?)(\S+?)\1\s*\{([^}]*)\}/g)) {
    const [, , pattern, body] = block;
    if (pattern && body?.includes('zone=vdsignin')) patterns.push(new RegExp(pattern, 'i'));
  }
  return patterns;
}

const inZone = (patterns: RegExp[], path: string) => patterns.some((pattern) => pattern.test(path));

describe('the nginx auth zone (ADR 0008)', () => {
  it('covers every customer route that checks a password or a code, or makes a passkey challenge', () => {
    const zone = authZonePatterns('digital.vertexmedia.pro');
    const paths = [
      '/sign-in/email',
      '/email-otp/verify-email',
      ...CUSTOMER_AUTH_NEST_PATHS.filter(
        (path) => !['/registration', '/revoke-session', '/revoke-sessions'].includes(path),
      ),
      ...Object.values(PASSKEY_PATHS),
    ].map((path) => `/api/auth${path}`);
    paths.push('/api/account/passkeys/authorize');
    expect(paths.filter((path) => !inZone(zone, path))).toEqual([]);
    // Pages and reads outside it keep the general limits.
    expect(inZone(zone, '/api/auth/get-session')).toBe(false);
    expect(inZone(zone, '/api/account/passkeys')).toBe(false);
  });

  it('covers every admin route that checks a password or a code', () => {
    const zone = authZonePatterns('digital-admin.vertexmedia.pro');
    const paths = [
      '/api/admin/auth/sign-in/email',
      '/api/admin/auth/two-factor/verify-totp',
      '/api/admin/auth/two-factor/verify-backup-code',
      '/api/admin/auth/two-factor/enable',
      '/api/admin/auth/two-factor/generate-backup-codes',
      '/api/admin/auth/change-password',
      '/api/admin/me/reauthenticate',
    ];
    expect(paths.filter((path) => !inZone(zone, path))).toEqual([]);
  });
});
