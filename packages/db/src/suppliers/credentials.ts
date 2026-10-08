import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Supplier credentials at rest (S07 rule SP2, ADR 0005): AES-256-GCM of the JSON of the credential
 * fields, with a random 96-bit IV, the supplier id as associated data (a ciphertext moved to
 * another supplier fails), and a key-version byte for rotation. The key is
 * `SUPPLIER_KEYS_SECRET` (32 bytes, base64) in the API and worker environments, never in the
 * database. Layout: version (1) · IV (12) · tag (16) · ciphertext.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The 32-byte key from its base64 text; throws on any other length. */
export function supplierKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new RangeError('SUPPLIER_KEYS_SECRET must be 32 bytes in base64');
  return key;
}

export function encryptCredentials(
  key: Buffer,
  supplierId: string,
  values: Record<string, string>,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(supplierId, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Throws when the key, the supplier or the bytes are not the ones it was written with. */
export function decryptCredentials(
  key: Buffer,
  supplierId: string,
  ciphertext: Buffer,
): Record<string, string> {
  if (ciphertext[0] !== VERSION) throw new Error('Unknown supplier credentials key version');
  const iv = ciphertext.subarray(1, 1 + IV_BYTES);
  const tag = ciphertext.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(supplierId, 'utf8'));
  decipher.setAuthTag(tag);
  const body = Buffer.concat([
    decipher.update(ciphertext.subarray(1 + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  return JSON.parse(body.toString('utf8')) as Record<string, string>;
}

/** Per field, its last 4 characters, for the masked display ("…a1b2"). */
export function credentialHints(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, value.slice(-4)]),
  );
}
