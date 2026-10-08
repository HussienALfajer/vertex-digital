import { Inject, Injectable } from '@nestjs/common';
import { type SupplierCode, supplierAvailable } from '@vertex-digital/contracts';
import {
  type Database,
  decryptCredentials,
  supplierCredentials,
  supplierKey,
  type Transaction,
} from '@vertex-digital/db';
import { FakeSupplierAdapter, type SupplierAdapter } from '@vertex-digital/suppliers';
import { desc, eq } from 'drizzle-orm';
import { ENV, type Env } from '../core/config/env.js';
import { readFakeSupplierState } from './fake-state-file.js';

/** A supplier's adapter with its credentials, and the values to keep out of every message. */
export interface ConnectedSupplier {
  adapter: SupplierAdapter;
  /** The decrypted credential values: never logged, stored or sent (rule SP2). */
  secrets: string[];
}

/**
 * The adapters this build has (S07 rule SP1, ADR 0005). Credentials are decrypted per call, kept
 * in memory only for it, and never logged. Each real adapter's PR adds its case to `get`.
 */
@Injectable()
export class SupplierRegistry {
  private readonly key: Buffer;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = supplierKey(env.SUPPLIER_KEYS_SECRET);
  }

  get fakeEnabled(): boolean {
    return this.env.SUPPLIER_FAKE_ENABLED;
  }

  /** The adapter of `code` with these credentials, or null when this build has none. */
  async get(
    code: SupplierCode,
    credentials: Record<string, string>,
  ): Promise<SupplierAdapter | null> {
    if (!supplierAvailable(code, { fakeEnabled: this.fakeEnabled })) return null;
    if (code !== 'fake') return null;
    return new FakeSupplierAdapter({
      webhookSecret: credentials.webhookSecret ?? '',
      state: await readFakeSupplierState(this.env.FAKE_SUPPLIER_STATE_FILE),
    });
  }

  /**
   * The supplier's adapter with its newest credentials, or null when it has no adapter here or no
   * credentials. Throws when the credentials cannot be decrypted (another key, moved bytes).
   */
  async connect(
    db: Database | Transaction,
    supplier: { id: string; code: SupplierCode },
  ): Promise<ConnectedSupplier | null> {
    const [row] = await db
      .select({ ciphertext: supplierCredentials.ciphertext })
      .from(supplierCredentials)
      .where(eq(supplierCredentials.supplierId, supplier.id))
      .orderBy(desc(supplierCredentials.createdAt), desc(supplierCredentials.id))
      .limit(1);
    if (!row) return null;
    const credentials = decryptCredentials(this.key, supplier.id, row.ciphertext);
    const adapter = await this.get(supplier.code, credentials);
    return adapter && { adapter, secrets: Object.values(credentials) };
  }
}
