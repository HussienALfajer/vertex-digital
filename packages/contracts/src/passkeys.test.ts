import { describe, expect, it } from 'vitest';
import {
  authorizePasskeySchema,
  defaultPasskeyName,
  PASSKEY_FALLBACK_NAME,
  passkeyGrantIdentifier,
  passkeyNameSchema,
  renamePasskeySchema,
} from './passkeys.js';

describe('passkeyNameSchema', () => {
  it('trims and accepts 1 to 40 printable characters', () => {
    expect(passkeyNameSchema.parse('  هاتفي  ')).toBe('هاتفي');
    expect(passkeyNameSchema.safeParse('a'.repeat(40)).success).toBe(true);
  });

  it('refuses empty, long and control characters', () => {
    for (const name of ['', '   ', 'a'.repeat(41), 'a‮b', 'a\nb', 'a‏b', 'a\u0000b']) {
      expect(passkeyNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('is the rename body', () => {
    expect(renamePasskeySchema.parse({ name: ' Laptop ' })).toEqual({ name: 'Laptop' });
    expect(renamePasskeySchema.safeParse({}).success).toBe(false);
  });
});

describe('defaultPasskeyName', () => {
  it('names the system and the browser, within the name rules', () => {
    const name = defaultPasskeyName({ system: 'iOS', browser: 'Safari' });
    expect(name).toBe('iOS · Safari');
    expect(passkeyNameSchema.parse(name)).toBe(name);
    expect(defaultPasskeyName({ system: 'Unknown', browser: 'Samsung Internet' })).toBe(
      'Samsung Internet',
    );
    expect(defaultPasskeyName({ system: 'Unknown', browser: 'Unknown' })).toBe(
      PASSKEY_FALLBACK_NAME,
    );
  });
});

describe('passkeyGrantIdentifier', () => {
  it('keys the grant by session', () => {
    expect(passkeyGrantIdentifier('s1')).toBe('passkey-grant:s1');
  });
});

describe('authorizePasskeySchema', () => {
  it('bounds the password', () => {
    expect(authorizePasskeySchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(authorizePasskeySchema.safeParse({ password: '' }).success).toBe(false);
    expect(authorizePasskeySchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(false);
  });
});
