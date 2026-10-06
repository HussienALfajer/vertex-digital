import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AltchaService } from './altcha.service.js';

const REQUIRE_ALTCHA = Symbol('REQUIRE_ALTCHA');

/** The header carrying the widget's base64 payload. */
export const ALTCHA_HEADER = 'x-altcha';

/**
 * Requires a solved ALTCHA challenge in the `X-Altcha` header (ADR 0008): sign-up, OTP requests,
 * password reset, deposit and ticket creation. `400 ALTCHA_REQUIRED` / `ALTCHA_INVALID` otherwise.
 */
export const RequireAltcha = () => SetMetadata(REQUIRE_ALTCHA, true);

@Injectable()
export class AltchaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly altcha: AltchaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_ALTCHA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const { headers } = context.switchToHttp().getRequest<{ headers: IncomingHttpHeaders }>();
    const value = headers[ALTCHA_HEADER];
    await this.altcha.verify(Array.isArray(value) ? value[0] : value);
    return true;
  }
}
