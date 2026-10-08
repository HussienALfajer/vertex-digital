/**
 * Plays Telegram against the local webhook (S05, development only: refused in production), for
 * the owner's acceptance with the worker's `log` transport. The fake admin is one Telegram user
 * in a private chat.
 *
 *   pnpm --filter @vertex-digital/api telegram:fake-update --start <code or deep link>
 *   pnpm --filter @vertex-digital/api telegram:fake-update --text /status
 *   pnpm --filter @vertex-digital/api telegram:fake-update --tap "الإيداعات"
 *
 * `--tap` presses the button with that text on the newest message file that has it, in
 * `--dir` (the worker's TELEGRAM_LOG_DIR; default `../worker/.data/telegram`, as `pnpm dev` runs
 * the worker in `apps/worker`).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { parseEnv } from '../core/config/env.js';

const argsSchema = z
  .object({
    start: z.string().optional(),
    text: z.string().optional(),
    tap: z.string().optional(),
    user: z.coerce.number().int().positive().default(1_000_001),
    dir: z.string().default('../worker/.data/telegram'),
  })
  .refine((args) => [args.start, args.text, args.tap].filter(Boolean).length === 1, {
    message: 'Give exactly one of --start, --text and --tap',
  });

loadRootEnv();
const env = parseEnv();
const { values } = parseArgs({
  options: {
    start: { type: 'string' },
    text: { type: 'string' },
    tap: { type: 'string' },
    user: { type: 'string' },
    dir: { type: 'string' },
  },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: telegram:fake-update --start <code or link> | --text <text> | --tap <button text>
  [--user <telegram user id>] [--dir <message files>]\n
${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
if (env.NODE_ENV === 'production' || !env.TELEGRAM_WEBHOOK_SECRET) {
  console.error('telegram:fake-update is for development only.');
  process.exit(1);
}

const args = parsed.data;
const from = { id: args.user, is_bot: false, first_name: 'Owner', username: 'local_owner' };
const chat = { id: args.user, type: 'private' };
const updateId = Date.now();

interface MessageFile {
  name: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** The callback data of the newest button with `text`. */
async function buttonData(text: string): Promise<string | null> {
  const dir = resolve(args.dir);
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
  for (const name of names.sort().reverse()) {
    const file = JSON.parse(await readFile(join(dir, name), 'utf8')) as MessageFile;
    const button = file.reply_markup?.inline_keyboard.flat().find((item) => item.text === text);
    if (button) return button.callback_data;
  }
  return null;
}

let update: object;
if (args.tap) {
  const data = await buttonData(args.tap);
  if (!data) {
    console.error(`No button "${args.tap}" in the message files of ${resolve(args.dir)}.`);
    process.exit(1);
  }
  update = {
    update_id: updateId,
    callback_query: { id: String(updateId), from, message: { message_id: 1, chat }, data },
  };
} else {
  // `--start` takes the code or the whole deep link the panel shows.
  const code = args.start
    ? (new URL(args.start, 'https://t.me').searchParams.get('start') ?? args.start)
    : null;
  const text = code ? `/start ${code}` : (args.text as string);
  update = {
    update_id: updateId,
    message: {
      message_id: updateId % 1_000_000,
      date: Math.floor(updateId / 1000),
      from,
      chat,
      text,
    },
  };
}

const response = await fetch(`http://${env.API_HOST}:${env.API_PORT}/api/webhooks/telegram`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET,
  },
  body: JSON.stringify(update),
});
const body = await response.text();
process.stdout.write(`${response.status}${body ? ` ${body}` : ''}\n`);
if (!response.ok) process.exitCode = 1;
