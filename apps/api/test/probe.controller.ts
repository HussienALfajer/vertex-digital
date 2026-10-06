import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CurrentCustomer,
  CurrentStaff,
  CustomerRoute,
  Public,
  StaffRoute,
} from '../src/core/access/index.js';
import { RequireAltcha } from '../src/core/altcha/index.js';
import { RateLimit } from '../src/core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../src/modules/auth/index.js';
import type { StaffIdentity } from '../src/modules/staff/index.js';

const echoSchema = z.object({ name: z.string().min(1), age: z.int().positive() });

/**
 * Test-only routes that exercise the core (access, errors, rate limits, ALTCHA) before any
 * feature route exists. Mounted by `startApp({ controllers: [ProbeController] })`.
 */
@Controller()
export class ProbeController {
  @Get('probe/public')
  @Public()
  open() {
    return { ok: true };
  }

  @Get('probe/customer')
  @CustomerRoute()
  customer(@CurrentCustomer() customer: CustomerIdentity) {
    return { id: customer.id };
  }

  @Get('admin/probe/staff')
  @StaffRoute()
  staff(@CurrentStaff() member: StaffIdentity) {
    return { id: member.id, role: member.role };
  }

  @Get('admin/probe/manage')
  @StaffRoute('staff.manage')
  manage(@CurrentStaff() member: StaffIdentity) {
    return { id: member.id };
  }

  @Get('probe/undeclared')
  undeclared() {
    return { ok: true };
  }

  @Post('probe/echo')
  @Public()
  @HttpCode(200)
  echo(@Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>) {
    return body;
  }

  @Get('probe/crash')
  @Public()
  crash(): never {
    throw new Error('secret internal detail');
  }

  @Get('probe/limited')
  @Public()
  @RateLimit({ limit: 2, perSeconds: 60 })
  limited() {
    return { ok: true };
  }

  @Post('probe/altcha')
  @Public()
  @RequireAltcha()
  @HttpCode(200)
  altcha() {
    return { ok: true };
  }
}
