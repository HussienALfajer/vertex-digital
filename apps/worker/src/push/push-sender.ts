import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import webPush from 'web-push';

export interface PushSenderConfig {
  /** `log`: write each would-be request to a file and send nothing (S15 PD7, development). */
  transport: 'log' | 'web-push';
  vapid?: { publicKey: string; privateKey: string; subject: string };
  logDir: string;
}

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushRequest {
  /** Names the log file: one per notification (PD7). */
  notificationId: string;
  /** The JSON payload of rule PT1, under 1 KB. */
  payload: string;
  ttlSeconds: number;
  urgency: 'high' | 'normal';
  topic: string;
}

/** The push service's answer, or why there was none: a transient failure (PD4). */
export type PushResponse = { status: number } | { error: 'timeout' | 'network' };

/** Each request times out after 10 seconds (PD3). */
const TIMEOUT_MS = 10_000;

/**
 * The worker's web push client (S15 PD3, PD7): the only code that holds the VAPID private key.
 * `web-push` encrypts the payload (aes128gcm) and signs the VAPID JWT for the endpoint's origin;
 * the request goes out with `fetch`, never following a redirect (the URL is one a customer gave).
 * In `log` mode every request is a line in a file, as the email and Telegram `log` transports do.
 * Never logs the keys or the payload of a real send.
 */
export class PushSender {
  constructor(
    private readonly config: PushSenderConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** The current public key, or null when push is not configured. */
  get publicKey(): string | null {
    return this.config.vapid?.publicKey ?? null;
  }

  async send(device: PushDevice, request: PushRequest): Promise<PushResponse> {
    const vapid = this.config.vapid;
    if (!vapid) throw new Error('Web push is not configured');
    const options = {
      vapidDetails: vapid,
      TTL: request.ttlSeconds,
      urgency: request.urgency,
      topic: request.topic,
      contentEncoding: 'aes128gcm' as const,
    };
    if (this.config.transport === 'log') return this.write(device, request, options);
    const details = webPush.generateRequestDetails(device, request.payload, options);
    try {
      const response = await this.fetchFn(details.endpoint, {
        method: 'POST',
        headers: details.headers as Record<string, string>,
        body: details.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      return { status: response.status };
    } catch (error) {
      return {
        error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
      };
    }
  }

  /** PD7: the endpoint's host, the headers a push service would see (not the VAPID JWT), the payload. */
  private async write(
    device: PushDevice,
    request: PushRequest,
    options: { TTL: number; urgency: string; topic: string },
  ): Promise<PushResponse> {
    const dir = resolve(this.config.logDir);
    await mkdir(dir, { recursive: true });
    const line = {
      at: new Date().toISOString(),
      host: new URL(device.endpoint).host,
      headers: { TTL: String(options.TTL), Urgency: options.urgency, Topic: options.topic },
      payload: JSON.parse(request.payload) as unknown,
    };
    await appendFile(join(dir, `${request.notificationId}.jsonl`), `${JSON.stringify(line)}\n`);
    return { status: 201 };
  }
}
