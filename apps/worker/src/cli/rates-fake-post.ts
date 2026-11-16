/**
 * Posts to a fake rate channel (S27, development only: refused unless RATE_FEED=fake), for the
 * owner's local acceptance. Adds a post with the current time to the channel's page under
 * RATE_FEED_FAKE_DIR, which the API's test read and the worker's `rates.poll` read instead of
 * t.me. Add the channel in the panel with the same handle.
 *
 *   pnpm --filter @vertex-digital/worker rates:fake-post --channel damascus_rates --text "دمشق مبيع 131"
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRateSourceHandle } from '@vertex-digital/contracts';
import { loadRootEnv } from '@vertex-digital/db';
import { writeFakeTelegramPost } from '@vertex-digital/suppliers';
import { z } from 'zod';
import { parseEnv } from '../core/config/env.js';

const argsSchema = z.object({
  channel: z
    .string()
    .refine(
      (handle) => isRateSourceHandle('telegram_channel', handle),
      'Expected a channel username',
    ),
  text: z.string().trim().min(1).max(4000),
});

loadRootEnv();
const env = parseEnv();
if (env.RATE_FEED !== 'fake') {
  process.stderr.write('rates:fake-post needs RATE_FEED=fake\n');
  process.exit(1);
}
const { values } = parseArgs({
  options: { channel: { type: 'string' }, text: { type: 'string' } },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  process.stderr.write(`${parsed.error.issues.map((issue) => issue.message).join('\n')}\n`);
  process.stderr.write('Usage: rates:fake-post --channel <username> --text <post text>\n');
  process.exit(1);
}
const file = await writeFakeTelegramPost(
  resolve(env.RATE_FEED_FAKE_DIR),
  parsed.data.channel,
  parsed.data.text,
  new Date(),
);
process.stdout.write(`Posted to ${parsed.data.channel} (${file})\n`);
