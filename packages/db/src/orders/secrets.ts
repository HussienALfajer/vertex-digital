import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Order codes and supplier webhook bodies at rest (S08 rules C1, F4; ADR 0004): AES-256-GCM with
 * a random 96-bit IV, the row id as associated data (a ciphertext moved to another row fails),
 * and a key-version byte for rotation. The key is `ORDER_CODES_SECRET` (32 bytes, base64) in the
 * API and worker environments, separate from `SUPPLIER_KEYS_SECRET`, never in the database.
 * Layout: version (1) · IV (12) · tag (16) · ciphertext. Plaintexts are never logged.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The 32-byte key from its base64 text; throws on any other length. */
export function orderCodesKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new RangeError('ORDER_CODES_SECRET must be 32 bytes in base64');
  return key;
}

export function encryptSecret(key: Buffer, rowId: string, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(rowId, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Throws when the key, the row or the bytes are not the ones it was written with. */
export function decryptSecret(key: Buffer, rowId: string, ciphertext: Buffer): string {
  if (ciphertext[0] !== VERSION) throw new Error('Unknown order secret key version');
  const iv = ciphertext.subarray(1, 1 + IV_BYTES);
  const tag = ciphertext.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(rowId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext.subarray(1 + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
