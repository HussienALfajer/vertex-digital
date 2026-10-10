import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { DepositsModule } from '../deposits/index.js';
import { SettingsModule } from '../settings/index.js';
import { TelegramAdminController } from './telegram.admin.controller.js';
import { TelegramService } from './telegram.service.js';
import { TelegramBotService } from './telegram-bot.service.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';

/**
 * The Telegram admin bot (S05 F07, ADR 0019): `telegram_links`, `telegram_link_codes`,
 * `telegram_messages`, `telegram_updates`, `telegram_prompts`. A domain module above `deposits`
 * and `settings`: bot actions run through their services with the channel `telegram`. Other
 * modules queue bot messages with `queueTelegramMessage` from `packages/db`, never through here.
 * S11: the dashboard reads the link's status (`TelegramService.status`).
 */
@Module({
  imports: [AdminModule, DepositsModule, SettingsModule],
  controllers: [TelegramAdminController, TelegramWebhookController],
  providers: [TelegramService, TelegramBotService],
  exports: [TelegramService],
})
export class TelegramModule {}
