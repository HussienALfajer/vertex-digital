import { Body, Controller, Get, HttpCode, Post, Req, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type ChangePassword,
  changePasswordSchema,
  confirmEmailChangeSchema,
  customerSignUpSchema,
  type RequestEmailChange,
  registrationSchema,
  requestCodeSchema,
  requestEmailChangeSchema,
  resetPasswordSchema,
  revokeSessionSchema,
  signUpResultSchema,
  successSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute, Public } from '../../core/access/index.js';
import { RequireAltcha } from '../../core/altcha/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from './auth.service.js';
import { AuthAccountService } from './auth-account.service.js';

const SUCCESS = { success: true } as const;

/**
 * Account changes under `/api/auth` (S01): Nest routes in front of the Better Auth instance, so
 * each change is validated by its contract, audited and emailed in one transaction. Answers that
 * could tell whether an email has an account are the same either way (rules C2, C12).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly accounts: AuthAccountService) {}

  @Get('registration')
  @Public()
  // Read by the store header on every page: room for many customers behind one carrier address.
  @RateLimit({ limit: 300, perSeconds: 60 })
  @SerializeOptions({ schema: registrationSchema })
  @ApiOkResponse({
    description: 'Whether customers can sign up (rule C16)',
    standardSchema: registrationSchema,
  })
  registration() {
    return { open: this.accounts.registrationOpen() };
  }

  @Post('sign-up/email')
  @Public()
  @RequireAltcha()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: signUpResultSchema })
  @ApiOkResponse({ description: 'A code was sent (rule C2)', standardSchema: signUpResultSchema })
  async signUp(
    @Body({ schema: customerSignUpSchema }) body: z.output<typeof customerSignUpSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.signUp(body, requestMeta(request));
    return { status: 'code_sent' } as const;
  }

  @Post('email-otp/send-verification-otp')
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
    @Body({ schema: requestCodeSchema }) body: z.output<typeof requestCodeSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.sendVerificationCode(body.email, requestMeta(request));
    return SUCCESS;
  }

  @Post('email-otp/request-password-reset')
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
    @Body({ schema: requestCodeSchema }) body: z.output<typeof requestCodeSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.requestPasswordReset(body.email, requestMeta(request));
    return SUCCESS;
  }

  @Post('email-otp/reset-password')
  @Public()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({ description: 'Set; every session is signed out', standardSchema: successSchema })
  async resetPassword(
    @Body({ schema: resetPasswordSchema }) body: z.output<typeof resetPasswordSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.resetPassword(body, requestMeta(request));
    return SUCCESS;
  }

  @Post('change-password')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'Changed; other sessions are signed out',
    standardSchema: successSchema,
  })
  async changePassword(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: changePasswordSchema }) body: ChangePassword,
    @Req() request: Request,
  ) {
    await this.accounts.changePassword(customer, body, requestMeta(request));
    return SUCCESS;
  }

  @Post('email-otp/request-email-change')
  @CustomerRoute()
  @RequireAltcha()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'Always, whether or not a code was sent',
    standardSchema: successSchema,
  })
  async requestEmailChange(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: requestEmailChangeSchema }) body: RequestEmailChange,
    @Req() request: Request,
  ) {
    await this.accounts.requestEmailChange(customer, body, requestMeta(request));
    return SUCCESS;
  }

  @Post('email-otp/change-email')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({
    description: 'Changed; other sessions are signed out',
    standardSchema: successSchema,
  })
  async confirmEmailChange(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: confirmEmailChangeSchema }) body: z.output<typeof confirmEmailChangeSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.confirmEmailChange(customer, body, requestMeta(request));
    return SUCCESS;
  }

  @Post('revoke-session')
  @CustomerRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({ description: 'The session is signed out', standardSchema: successSchema })
  async revokeSession(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: revokeSessionSchema }) body: z.output<typeof revokeSessionSchema>,
    @Req() request: Request,
  ) {
    await this.accounts.revokeSession(customer, body.token, requestMeta(request));
    return SUCCESS;
  }

  @Post('revoke-sessions')
  @CustomerRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: successSchema })
  @ApiOkResponse({ description: 'Every session is signed out', standardSchema: successSchema })
  async revokeSessions(@CurrentCustomer() customer: CustomerIdentity, @Req() request: Request) {
    await this.accounts.revokeAllSessions(customer, requestMeta(request));
    return SUCCESS;
  }
}
