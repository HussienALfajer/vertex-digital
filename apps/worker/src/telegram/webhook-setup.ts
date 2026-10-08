import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../core/config/env.js';
import { TelegramBot } from './bot-api.js';

/**
 * Registers the webhook at start (S05 rule TG2) when the bot talks to Telegram: idempotent, so
 * every start sends it again. A failure is logged and retried at the next start; messages stay
 * queued meanwhile.
 */
@Injectable()
export class TelegramWebhookSetup implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramWebhookSetup.name);

  constructor(
    private readonly bot: TelegramBot,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.bot.transport !== 'api' || !this.env.TELEGRAM_BOT_TOKEN) return;
    try {
      await this.bot.call('setWebhook', {
        url: this.env.TELEGRAM_WEBHOOK_URL,
        secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      });
      this.logger.log('Telegram webhook registered');
    } catch (error) {
      this.logger.warn(`Telegram webhook not registered: ${(error as Error).message}`);
    }
  }
}
