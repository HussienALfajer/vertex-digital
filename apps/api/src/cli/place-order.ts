/**
 * Buys a product for a customer at its current price (S08, development only: refused in
 * production), through the same service as `POST /api/orders`, until S09's buy box exists.
 * Prints the order number and status.
 *
 *   pnpm --filter @vertex-digital/api order:place --email <customer> --product <id>
 *     [--quantity <n>] [--field <key>=<value>]…
 */
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { parseEnv } from '../core/config/env.js';
import { CodedException } from '../core/errors/index.js';
import { OrdersService } from '../modules/orders/index.js';

const argsSchema = z.object({
  email: z.email(),
  product: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  field: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,31}=.*$/, 'Expected <key>=<value>'))
    .default([]),
});

loadRootEnv();
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    product: { type: 'string' },
    quantity: { type: 'string' },
    field: { type: 'string', multiple: true },
  },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: order:place --email <customer> --product <id> [--quantity <n>] [--field <key>=<value>]…\n
${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
if (parseEnv().NODE_ENV === 'production') {
  console.error('order:place is for development only.');
  process.exit(1);
}

const args = parsed.data;
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const order = await app.get(OrdersService).placeForCli({
    email: args.email,
    productId: args.product,
    quantity: args.quantity,
    fields: Object.fromEntries(
      args.field.map((pair) => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    ),
  });
  process.stdout.write(`Paid ${order.number} (${order.stage}): ${order.id}\n`);
} catch (error) {
  if (!(error instanceof CodedException)) throw error;
  const { details } = error.getResponse() as { details?: unknown };
  console.error(`Refused: ${error.code}${details ? ` ${JSON.stringify(details)}` : ''}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
