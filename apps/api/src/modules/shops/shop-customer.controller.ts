import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type CursorQuery,
  cursorQuerySchema,
  requestCodeSchema,
  resetPasswordSchema,
  returnRequestSchema,
  shopCustomerProfileSchema,
  shopSignUpSchema,
  shopWalletEntryPageSchema,
  shopWalletSchema,
  signUpResultSchema,
  successSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentShopCustomer, Public, ShopCustomerRoute } from '../../core/access/index.js';
import { RequireAltcha } from '../../core/altcha/index.js';
import { CodedException } from '../../core/errors/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { ShopAccountsService } from './shop-accounts.service.js';
import { ShopAuthService, type ShopCustomerIdentity } from './shop-auth.service.js';
import { ShopCustomersService } from './shop-customers.service.js';

const SUCCESS = { success: true } as const;

/**
 * The shop customer realm under `/api/shops/:slug/` (S26, ADR 0040): the account routes the
 * shops module serves in front of the shop's Better Auth instance (sign-up, codes, reset), then
 * the signed-in customer's own profile, wallet and return requests. A session of another shop,
 * a Vertex session or none is `401`.
 */
@ApiTags('shops')
@Controller('shops/:slug')
export class ShopCustomerController {
  constructor(
    private readonly auth: ShopAuthService,
    private readonly accounts: ShopAccountsService,
    private readonly customers: ShopCustomersService,
  ) {}

  @Post('auth/sign-up')
  @Public()
  @RequireAltcha()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: signUpResultSchema })
  @ApiOkResponse({ description: 'A code was sent (CA2, CA3)', standardSchema: signUpResultSchema })
  async signUp(
    @Param('slug') slug: string,
    @Body({ schema: shopSignUpSchema }) body: z.output<typeof shopSignUpSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.signUp(await this.shop(slug), body, requestMeta(request));
    return { status: 'code_sent' } as const;
  }

  @Post('auth/send-verification-otp')
  @Public()
  @RequireAltcha()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'Always, whether or not a code was sent',
    standardSchema: successSchema,
  })
  async sendVerificationCode(
    @Param('slug') slug: string,
    @Body({ schema: requestCodeSchema }) body: z.output<typeof requestCodeSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.sendVerificationCode(
      await this.shop(slug),
      body.email,
      requestMeta(request),
    );
    return SUCCESS;
  }

  @Post('auth/request-password-reset')
  @Public()
  @RequireAltcha()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'Always, whether or not a code was sent',
    standardSchema: successSchema,
  })
  async requestPasswordReset(
    @Param('slug') slug: string,
    @Body({ schema: requestCodeSchema }) body: z.output<typeof requestCodeSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.requestPasswordReset(
      await this.shop(slug),
      body.email,
      requestMeta(request),
    );
    return SUCCESS;
  }

  @Post('auth/reset-password')
  @Public()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'The password set, every session signed out',
    standardSchema: successSchema,
  })
  async resetPassword(
    @Param('slug') slug: string,
    @Body({ schema: resetPasswordSchema }) body: z.output<typeof resetPasswordSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.resetPassword(await this.shop(slug), body, requestMeta(request));
    return SUCCESS;
  }

  @Get('me')
  @ShopCustomerRoute()
  @SerializeOptions({ schema: shopCustomerProfileSchema })
  @ApiOkResponse({ description: 'The shop customer', standardSchema: shopCustomerProfileSchema })
  me(@CurrentShopCustomer() customer: ShopCustomerIdentity) {
    return this.customers.profile(customer);
  }

  @Get('wallet')
  @ShopCustomerRoute()
  @SerializeOptions({ schema: shopWalletSchema })
  @ApiOkResponse({
    description: 'The balance and a pending return',
    standardSchema: shopWalletSchema,
  })
  wallet(@CurrentShopCustomer() customer: ShopCustomerIdentity) {
    return this.customers.wallet(customer);
  }

  @Get('wallet/entries')
  @ShopCustomerRoute()
  @ApiQueryOf(cursorQuerySchema)
  @SerializeOptions({ schema: shopWalletEntryPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: shopWalletEntryPageSchema })
  entries(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ) {
    return this.customers.entries(customer, query);
  }

  @Post('return-requests/:id/confirm')
  @ShopCustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: returnRequestSchema })
  @ApiCreatedResponse({
    description: 'Returned (200: a replay)',
    standardSchema: returnRequestSchema,
  })
  async confirm(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertActive(customer);
    const { request: ended, replayed } = await this.customers.answerReturn(
      customer,
      id,
      { action: 'confirm', idempotencyKey },
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return ended;
  }

  @Post('return-requests/:id/decline')
  @ShopCustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: returnRequestSchema })
  @ApiOkResponse({ description: 'Declined', standardSchema: returnRequestSchema })
  async decline(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    const { request: ended } = await this.customers.answerReturn(
      customer,
      id,
      { action: 'decline' },
      requestMeta(request),
    );
    return ended;
  }

  /** CA7: a frozen customer confirms nothing (checked again under the locks). */
  private assertActive(customer: ShopCustomerIdentity) {
    if (customer.frozen) throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
  }

  private async shop(slug: string) {
    const shop = await this.auth.shopBySlug(slug);
    if (!shop) throw new CodedException(404, 'NOT_FOUND', 'No such shop');
    return shop;
  }
}
