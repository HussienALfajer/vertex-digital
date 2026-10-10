/**
 * Buys a product for a customer at its current price (S08, development only: refused in
 * production), through the same service as `POST /api/orders`. S09: `--reserve` reserves the
 * order when the balance is short (`whenBalanceShort: 'reserve'`), `--confirm-player` confirms a
 * player id that is not known valid. S10: `--save <label>` saves the player id, `--gift-sender`
 * and `--gift-message` make it a gift. Prints the order number and stage.
 *
 *   pnpm --filter @vertex-digital/api order:place --email <customer> --product <id>
 *     [--quantity <n>] [--field <key>=<value>]… [--reserve] [--confirm-player]
 *     [--save <label>] [--gift-sender <name>] [--gift-message <text>]
 */
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { giftSchema, savedPlayerLabelSchema } from '@vertex-digital/contracts';
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
  reserve: z.boolean().default(false),
  'confirm-player': z.boolean().default(false),
  save: savedPlayerLabelSchema.optional(),
  'gift-sender': giftSchema.shape.senderName,
  'gift-message': giftSchema.shape.message,
});

loadRootEnv();
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    product: { type: 'string' },
    quantity: { type: 'string' },
    field: { type: 'string', multiple: true },
    reserve: { type: 'boolean' },
    'confirm-player': { type: 'boolean' },
    save: { type: 'string' },
    'gift-sender': { type: 'string' },
    'gift-message': { type: 'string' },
  },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: order:place --email <customer> --product <id> [--quantity <n>] [--field <key>=<value>]… [--reserve] [--confirm-player] [--save <label>] [--gift-sender <name>] [--gift-message <text>]\n
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
    reserve: args.reserve,
    confirmPlayer: args['confirm-player'],
    ...(args.save && { saveLabel: args.save }),
    ...((args['gift-sender'] !== undefined || args['gift-message'] !== undefined) && {
      gift: {
        ...(args['gift-sender'] && { senderName: args['gift-sender'] }),
        ...(args['gift-message'] && { message: args['gift-message'] }),
      },
    }),
  });
  const verb = order.stage === 'awaiting_balance' ? 'Reserved' : 'Paid';
  process.stdout.write(`${verb} ${order.number} (${order.stage}): ${order.id}\n`);
  if (order.savedPlayer) process.stdout.write(`Saved player id: ${order.savedPlayer.label}\n`);
  for (const link of order.shareLinks) process.stdout.write(`Gift link: ${link.url}\n`);
} catch (error) {
  if (!(error instanceof CodedException)) throw error;
  const { details } = error.getResponse() as { details?: unknown };
  console.error(`Refused: ${error.code}${details ? ` ${JSON.stringify(details)}` : ''}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
