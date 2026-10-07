import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AdminChangePassword,
  adminChangePasswordSchema,
  adminSessionListSchema,
  adminSessionSchema,
  type Reauthenticate,
  reauthenticateSchema,
  reauthenticationSchema,
  successSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, AdminSetupRoute, CurrentAdmin } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { AdminAccountService } from './admin-account.service.js';
import type { AdminIdentity } from './admin-auth.service.js';

/** The admin's own account (S01 rules D1, D5, D7). */
@ApiTags('admin-account')
@Controller('admin')
export class AdminAccountController {
  constructor(private readonly account: AdminAccountService) {}

  /** In front of Better Auth's path; allowed while the CLI-issued password is pending (D1). */
  @Post('auth/change-password')
  @AdminSetupRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({ description: 'Changed; other sessions end', standardSchema: successSchema })
  async changePassword(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: adminChangePasswordSchema }) body: AdminChangePassword,
    @Req() request: Request,
  ) {
    await this.account.changePassword(admin, body, requestMeta(request));
    return { success: true } as const;
  }

  @Post('me/reauthenticate')
  @AdminRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: reauthenticationSchema })
  @ApiOkResponse({
    description: 'Sensitive routes are open until then',
    standardSchema: reauthenticationSchema,
  })
  reauthenticate(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: reauthenticateSchema }) body: Reauthenticate,
    @Req() request: Request,
  ) {
    return this.account.reauthenticate(admin, body, request.headers);
  }

  @Get('me/sessions')
  @AdminRoute()
  // Nest serializes an array item by item: the item schema shapes each session.
  @SerializeOptions({ schema: adminSessionSchema })
  @ApiOkResponse({ description: 'The admin’s sessions', standardSchema: adminSessionListSchema })
  sessions(@CurrentAdmin() admin: AdminIdentity) {
    return this.account.sessions(admin);
  }

  @Delete('me/sessions/:id')
  @AdminRoute()
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'The session is signed out' })
  async revokeSession(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.account.revokeSession(admin, id, requestMeta(request));
  }
}
