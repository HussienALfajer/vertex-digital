import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  type SupplierCallOperation,
  type SupplierCallResult,
  type SupplierCode,
  supplierAvailable,
  supplierChecksPlayers,
} from '@vertex-digital/contracts';
import {
  type Database,
  decryptCredentials,
  newId,
  supplierCalls,
  supplierCredentials,
  supplierKey,
  type Transaction,
} from '@vertex-digital/db';
import {
  FakeSupplierAdapter,
  type FakeSupplierState,
  FazercardsAdapter,
  fakeSupplierStateSchema,
  type SupplierAdapter,
  SupplierError,
  WdgzoneAdapter,
} from '@vertex-digital/suppliers';
import { desc, eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';

/*
 * The adapters the API calls itself (S08 webhooks, S09 player checks), as the worker's
 * `SupplierRegistry`: the newest credentials decrypted per call, never logged or returned. Each
 * real adapter's PR adds its case (Q12).
 */

@Injectable()
export class SupplierAdaptersService {
  private readonly key: Buffer;
  private readonly fakeStateFile: string;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = supplierKey(env.SUPPLIER_KEYS_SECRET as string);
    this.fakeStateFile = isAbsolute(env.FAKE_SUPPLIER_STATE_FILE)
      ? env.FAKE_SUPPLIER_STATE_FILE
      : resolve('..', 'worker', env.FAKE_SUPPLIER_STATE_FILE);
  }

  /**
   * Rule PV1: this build has an adapter for the supplier that checks player ids, as a game's
   * provider (S19 PC1, the default) or by a route (S09 PV2).
   */
  canValidatePlayer(code: SupplierCode, by: 'route' | 'provider' = 'provider'): boolean {
    return supplierChecksPlayers(code, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED, by });
  }

  /** The adapter with its newest credentials, or null: none in this build, or none set. */
  async connect(
    supplier: { id: string; code: SupplierCode },
    db: Database | Transaction = this.db,
  ): Promise<SupplierAdapter | null> {
    if (!supplierAvailable(supplier.code, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED })) {
      return null;
    }
    const [row] = await db
      .select({ ciphertext: supplierCredentials.ciphertext })
      .from(supplierCredentials)
      .where(eq(supplierCredentials.supplierId, supplier.id))
      .orderBy(desc(supplierCredentials.createdAt), desc(supplierCredentials.id))
      .limit(1);
    if (!row) return null;
    const credentials = decryptCredentials(this.key, supplier.id, row.ciphertext);
    // The API only verifies and reads webhooks: no callback URL is needed here.
    if (supplier.code === 'wdgzone') {
      return credentials.apiKey ? new WdgzoneAdapter({ apiKey: credentials.apiKey }) : null;
    }
    if (supplier.code === 'fazercards') {
      return credentials.apiKey && credentials.webhookSecret
        ? new FazercardsAdapter({
            apiKey: credentials.apiKey,
            webhookSecret: credentials.webhookSecret,
          })
        : null;
    }
    if (supplier.code !== 'fake') return null;
    return new FakeSupplierAdapter({
      webhookSecret: credentials.webhookSecret ?? '',
      state: await this.fakeState(),
    });
  }

  /**
   * One adapter call made by the API, recorded for health (S07 rule H1); S18 FK1: a failed one
   * with why (`error`), its HTTP status and the supplier's code, from the error it threw.
   */
  async recordCall(
    tx: Database | Transaction,
    call: {
      supplierId: string;
      operation: SupplierCallOperation;
      result: SupplierCallResult;
      latencyMs: number;
      error?: unknown;
    },
  ): Promise<void> {
    const { error, ...row } = call;
    const details = error instanceof SupplierError ? error.details : {};
    const status = details.status;
    await tx.insert(supplierCalls).values({
      id: newId(),
      ...row,
      supplierCode: details.supplierCode?.slice(0, 64) ?? null,
      failureKind: row.result === 'error' ? (details.failure ?? 'other') : null,
      httpStatus: status !== undefined && status >= 100 && status <= 599 ? status : null,
    });
  }

  /** The fake's scripted state (`supplier:fake --errors`), read only; no file is the default. */
  private async fakeState(): Promise<FakeSupplierState> {
    try {
      return fakeSupplierStateSchema.parse(JSON.parse(await readFile(this.fakeStateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return fakeSupplierStateSchema.parse({});
      throw error;
    }
  }
}
