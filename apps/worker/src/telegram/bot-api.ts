import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export interface TelegramBotConfig {
  /** `log`: write each call as a JSON file under `logDir` and call nothing (S05, development). */
  transport: 'log' | 'api';
  botToken?: string;
  apiUrl: string;
  logDir: string;
}

/** A refusal or failure of the Bot API; `status` 0 when Telegram could not be reached. */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';

  constructor(
    readonly status: number,
    description: string,
    /** Seconds to wait, from a `429` (`parameters.retry_after`). */
    readonly retryAfter?: number,
  ) {
    super(status ? `HTTP ${status}: ${description}` : description);
  }
}

const TIMEOUT_MS = 10_000;

const replySchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.int().positive().optional() }).optional(),
});

/**
 * The worker's Telegram client (S05 F07, ADR 0019): the only code that holds the bot token. In
 * `log` mode every call becomes a file, as the email `log` transport does, so development and
 * tests never reach Telegram. Errors never carry the token: it is in the URL, which is not logged.
 */
export class TelegramBot {
  private written = 0;

  constructor(
    private readonly config: TelegramBotConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Calls can be made: the log transport, or the Bot API with a token. */
  get configured(): boolean {
    return this.config.transport === 'log' || Boolean(this.config.botToken);
  }

  get transport(): TelegramBotConfig['transport'] {
    return this.config.transport;
  }

  /** Calls a Bot API method; resolves with its `result`, throws `TelegramApiError`. */
  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.config.transport === 'log') return this.writeFile(method, payload);
    return this.post(method, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Calls a method that uploads a file (`sendPhoto` with a JPEG, S05 rule TC2), as multipart form
   * data; other fields are sent as text, objects as JSON. In `log` mode the file is written next
   * to the call's JSON file, which names it.
   */
  async callWithFile(
    method: string,
    payload: Record<string, unknown>,
    file: { field: string; name: string; type: string; bytes: Buffer },
  ): Promise<unknown> {
    if (this.config.transport === 'log') {
      const name = await this.writeBytes(file.name, file.bytes);
      return this.writeFile(method, { ...payload, [file.field]: name });
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    form.set(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return this.post(method, { body: form });
  }

  private async post(
    method: string,
    init: { headers?: Record<string, string>; body: string | FormData },
  ): Promise<unknown> {
    if (!this.config.botToken) throw new TelegramApiError(0, 'The bot token is not set');
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.apiUrl}/bot${this.config.botToken}/${method}`, {
        method: 'POST',
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // The request's URL holds the token: keep the error's class only.
      throw new TelegramApiError(0, `Telegram unreachable (${(error as Error).name})`);
    }
    const reply = replySchema.safeParse(await response.json().catch(() => null));
    if (response.ok && reply.success && reply.data.ok) return reply.data.result;
    throw new TelegramApiError(
      response.status,
      (reply.success && reply.data.description) || 'Unexpected reply',
      reply.success ? reply.data.parameters?.retry_after : undefined,
    );
  }

  /**
   * `<time>-<n>-<method>.json`; a send answers a made-up message id, as Telegram would. The
   * message files sort by name in the order they were written.
   */
  private async writeFile(method: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.writeBytes(
      `${method}.json`,
      Buffer.from(`${JSON.stringify({ method, ...payload }, null, 2)}\n`),
    );
    return { message_id: Date.now() % 1_000_000_000 };
  }

  /** Writes `<time>-<n>-<suffix>` under the log directory; returns the file name. */
  private async writeBytes(suffix: string, bytes: Buffer): Promise<string> {
    const dir = resolve(this.config.logDir);
    await mkdir(dir, { recursive: true });
    this.written += 1;
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const name = `${stamp}-${String(this.written).padStart(4, '0')}-${suffix}`;
    await writeFile(join(dir, name), bytes);
    return name;
  }
}
