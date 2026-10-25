import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AuthorizePasskey,
  authorizePasskeySchema,
  passkeyListSchema,
  passkeySchema,
  renamePasskeySchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from './auth.service.js';
import { AuthPasskeysService } from './auth-passkeys.service.js';

/**
 * The customer's passkeys (S22 PK2, PK4): the password grant, the list, rename and remove. The
 * registration and the sign-in are Better Auth endpoints (`passkeys.plugin.ts`).
 */
@ApiTags('account')
@Controller('account/passkeys')
export class AuthPasskeysController {
  constructor(private readonly passkeys: AuthPasskeysService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: passkeySchema })
  @ApiOkResponse({ description: 'Oldest first', standardSchema: passkeyListSchema })
  list(@CurrentCustomer() customer: CustomerIdentity) {
    return this.passkeys.list(customer.id);
  }

  /** PK2: the password opens this session's registration for 5 minutes (C11's limit). */
  @Post('authorize')
  @CustomerRoute()
  @HttpCode(204)
  @RateLimit({ limit: 10, perSeconds: 60 })
  @ApiNoContentResponse({ description: 'This session may register a passkey for 5 minutes' })
  async authorize(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: authorizePasskeySchema }) body: AuthorizePasskey,
  ) {
    await this.passkeys.authorize(customer, body.password);
  }

  @Patch(':id')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @SerializeOptions({ schema: passkeySchema })
  @ApiOkResponse({ description: 'The renamed passkey', standardSchema: passkeySchema })
  rename(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: renamePasskeySchema }) body: z.output<typeof renamePasskeySchema>,
  ) {
    return this.passkeys.rename(customer.id, id, body.name);
  }

  @Delete(':id')
  @CustomerRoute()
  @HttpCode(204)
  @RateLimit({ limit: 20, perSeconds: 60 })
  @ApiNoContentResponse({ description: 'The passkey no longer signs in' })
  async remove(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ) {
    await this.passkeys.remove(customer.id, id, requestMeta(request));
  }
}
