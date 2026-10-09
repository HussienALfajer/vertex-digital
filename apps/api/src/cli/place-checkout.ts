/**
 * Pays a cart for a customer at each product's current price (S10 rule CT5, development only:
 * refused in production), through the same service as `POST /api/checkouts`. Each `--line` is a
 * product and an optional quantity; the `--field` options after it are that line's fields. The
 * player ids count as confirmed. Prints the checkout id and its order numbers.
 *
 *   pnpm --filter @vertex-digital/api checkout:place --email <customer>
 *     --line <product>[:<quantity>] [--field <key>=<value>]… [--line …]…
 */
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { CART_LINES_MAX } from '@vertex-digital/contracts';
import { loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { parseEnv } from '../core/config/env.js';
import { CodedException } from '../core/errors/index.js';
import { OrdersService } from '../modules/orders/index.js';

const USAGE =
  'Usage: checkout:place --email <customer> --line <product>[:<quantity>] [--field <key>=<value>]… [--line …]…';

const lineSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}(:\d{1,2})?$/i, 'Expected <product id>[:<quantity>]')
  .transform((text) => {
    const [productId, quantity] = text.split(':');
    return { productId: productId as string, quantity: Number(quantity ?? 1) };
  });
const fieldSchema = z.string().regex(/^[a-z][a-z0-9_]{1,31}=.*$/, 'Expected <key>=<value>');

loadRootEnv();
const { values, tokens } = parseArgs({
  options: {
    email: { type: 'string' },
    line: { type: 'string', multiple: true },
    field: { type: 'string', multiple: true },
  },
  tokens: true,
});

/** The lines in order, each with the fields given after it. */
const lines: { productId: string; quantity: number; fields: Record<string, string> }[] = [];
const issues: string[] = [];
for (const token of tokens) {
  if (token.kind !== 'option') continue;
  if (token.name === 'line') {
    const line = lineSchema.safeParse(token.value);
    if (line.success) lines.push({ ...line.data, fields: {} });
    else issues.push(`--line ${token.value}: ${z.prettifyError(line.error)}`);
  } else if (token.name === 'field') {
    const field = fieldSchema.safeParse(token.value);
    const current = lines.at(-1);
    if (!field.success || !current) {
      issues.push(`--field ${token.value}: expected <key>=<value> after a --line`);
      continue;
    }
    const at = field.data.indexOf('=');
    current.fields[field.data.slice(0, at)] = field.data.slice(at + 1);
  }
}
const email = z.email().safeParse(values.email);
if (!email.success) issues.push('--email: expected an email');
if (lines.length === 0 || lines.length > CART_LINES_MAX) {
  issues.push(`--line: expected 1 to ${CART_LINES_MAX} lines`);
}
if (issues.length > 0 || !email.success) {
  console.error(`${USAGE}\n\n${issues.join('\n')}`);
  process.exit(1);
}
if (parseEnv().NODE_ENV === 'production') {
  console.error('checkout:place is for development only.');
  process.exit(1);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const checkout = await app.get(OrdersService).checkoutForCli({ email: email.data, lines });
  process.stdout.write(`Paid checkout ${checkout.id}\n`);
  for (const order of checkout.orders) {
    process.stdout.write(`  ${order.number} (${order.stage}): ${order.productNameAr}\n`);
  }
} catch (error) {
  if (!(error instanceof CodedException)) throw error;
  const { details } = error.getResponse() as { details?: unknown };
  console.error(`Refused: ${error.code}${details ? ` ${JSON.stringify(details)}` : ''}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
