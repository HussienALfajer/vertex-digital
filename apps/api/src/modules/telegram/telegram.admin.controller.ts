import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { telegramLinkCodeSchema, telegramLinkStatusSchema } from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { TelegramService } from './telegram.service.js';

/** The panel's Telegram page (S05 F07, rule TG3): link status, linking, unlinking, a test. */
@ApiTags('telegram')
@Controller('admin/telegram')
export class TelegramAdminController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: telegramLinkStatusSchema })
  @ApiOkResponse({ description: 'The bot and its link', standardSchema: telegramLinkStatusSchema })
  status() {
    return this.telegram.status();
  }

  @Post('link-code')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: telegramLinkCodeSchema })
  @ApiCreatedResponse({
    description: 'A single-use link, valid 10 minutes, shown once',
    standardSchema: telegramLinkCodeSchema,
  })
  createLinkCode(@CurrentAdmin() admin: AdminIdentity, @Req() request: Request) {
    return this.telegram.createLinkCode(admin.id, requestMeta(request));
  }

  @Delete('link')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: telegramLinkStatusSchema })
  @ApiOkResponse({
    description: 'The status after unlinking',
    standardSchema: telegramLinkStatusSchema,
  })
  unlink(@CurrentAdmin() admin: AdminIdentity, @Req() request: Request) {
    return this.telegram.unlink(admin.id, requestMeta(request));
  }

  @Post('test')
  @AdminRoute()
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'A test message is queued for the linked chat' })
  async sendTest(): Promise<void> {
    await this.telegram.sendTest();
  }
}
