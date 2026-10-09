import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { QUEUES, supplierAvailable, supplierCodeSchema } from '@vertex-digital/contracts';
import {
  type Database,
  decryptCredentials,
  encryptSecret,
  newId,
  orderCodesKey,
  supplierCredentials,
  supplierKey,
  suppliers,
  supplierWebhookEvents,
} from '@vertex-digital/db';
import { FakeSupplierAdapter, type SupplierAdapter } from '@vertex-digital/suppliers';
import { desc, eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';

const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such supplier webhook');

/**
 * Supplier webhooks (S08 rule F4, ADR 0005): verified with the supplier's adapter and its newest
 * credentials, stored once per event id with the body encrypted (it may carry codes), then
 * handed to the worker (`suppliers.webhook`, rule F5). The answer comes at once; nothing here
 * changes an order. A body is never logged.
 */
@Injectable()
export class SupplierWebhooksService {
  private readonly logger = new Logger(SupplierWebhooksService.name);
  private readonly credentialsKey: Buffer;
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
  ) {
    this.credentialsKey = supplierKey(env.SUPPLIER_KEYS_SECRET as string);
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  async receive(
    code: string,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
  ): Promise<void> {
    const parsedCode = supplierCodeSchema.safeParse(code);
    if (!parsedCode.success) throw notFound();
    const [supplier] = await this.db
      .select()
      .from(suppliers)
      .where(eq(suppliers.code, parsedCode.data));
    if (!supplier) throw notFound();
    const adapter = await this.adapter(supplier);
    if (!adapter?.capabilities.webhooks) throw notFound();

    const request = { headers, rawBody: rawBody.toString('utf8') };
    if (!adapter.verifyWebhook(request)) {
      this.logger.warn({ supplier: supplier.code }, 'Supplier webhook refused: bad signature');
      throw new CodedException(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
    }
    // A malformed event is kept under its body's digest and marked by the worker.
    let eventId: string;
    try {
      eventId = adapter.parseWebhook(request).eventId.slice(0, 128);
    } catch {
      eventId = `malformed:${createHash('sha256').update(rawBody).digest('hex').slice(0, 64)}`;
    }
    await this.db.transaction(async (tx) => {
      const id = newId();
      const [stored] = await tx
        .insert(supplierWebhookEvents)
        .values({
          id,
          supplierId: supplier.id,
          eventId,
          bodyCiphertext: encryptSecret(this.codesKey, id, request.rawBody),
        })
        .onConflictDoNothing()
        .returning({ id: supplierWebhookEvents.id });
      // A replay of a stored event answers 200 and does nothing.
      if (!stored) return;
      await this.jobs.send(
        tx,
        QUEUES.suppliersWebhook,
        { eventId: stored.id },
        { retryLimit: 5, retryDelay: 10, retryBackoff: true },
      );
    });
  }

  /** The adapter with its newest credentials, or null: none in this build, or none set. */
  private async adapter(supplier: {
    id: string;
    code: typeof suppliers.$inferSelect.code;
  }): Promise<SupplierAdapter | null> {
    if (!supplierAvailable(supplier.code, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED })) {
      return null;
    }
    const [row] = await this.db
      .select({ ciphertext: supplierCredentials.ciphertext })
      .from(supplierCredentials)
      .where(eq(supplierCredentials.supplierId, supplier.id))
      .orderBy(desc(supplierCredentials.createdAt), desc(supplierCredentials.id))
      .limit(1);
    if (!row) return null;
    const credentials = decryptCredentials(this.credentialsKey, supplier.id, row.ciphertext);
    // Each real adapter's PR adds its case (Q12), as in the worker's registry.
    if (supplier.code !== 'fake') return null;
    return new FakeSupplierAdapter({ webhookSecret: credentials.webhookSecret ?? '' });
  }
}
