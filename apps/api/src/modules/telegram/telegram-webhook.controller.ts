import { Controller, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { TelegramBotService } from './telegram-bot.service.js';

/**
 * `POST /api/webhooks/telegram` (S05 rules TG2, TG4, TG5): Telegram's updates. Without the right
 * secret header: 401 with no body. Otherwise always 200, empty or with an inline
 * `answerCallbackQuery`, so Telegram never retries. Not in the OpenAPI document: no client calls it.
 */
@ApiExcludeController()
@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(private readonly bot: TelegramBotService) {}

  @Post()
  @Public()
  @HttpCode(200)
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.bot.verifySecret(secret)) {
      response.status(401).end();
      return;
    }
    const answer = await this.bot.handle(request.body, requestMeta(request));
    if (answer) response.status(200).json(answer);
    else response.status(200).end();
  }
}
