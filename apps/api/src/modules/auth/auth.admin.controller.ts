import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  createdTestCustomerSchema,
  createTestCustomerSchema,
  generatedPasswordSchema,
  testCustomerListQuerySchema,
  testCustomerPageSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { AuthTestCustomersService } from './auth-test-customers.service.js';

/** Test customers (S01 rules T1–T4), created by the admin while registration is closed. */
@ApiTags('test-customers')
@Controller('admin/test-customers')
export class AuthAdminController {
  constructor(private readonly testCustomers: AuthTestCustomersService) {}

  @Get()
  @AdminRoute()
  @SerializeOptions({ schema: testCustomerPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: testCustomerPageSchema })
  list(
    @Query({ schema: testCustomerListQuerySchema })
    query: z.output<typeof testCustomerListQuerySchema>,
  ) {
    return this.testCustomers.list(query);
  }

  @Post()
  @AdminRoute()
  @HttpCode(200)
  // The generated password is shown once: never cached anywhere.
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: createdTestCustomerSchema })
  @ApiOkResponse({
    description: 'The customer and its password, once',
    standardSchema: createdTestCustomerSchema,
  })
  create(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: createTestCustomerSchema }) body: z.output<typeof createTestCustomerSchema>,
    @Req() request: Request,
  ) {
    return this.testCustomers.create(admin.id, body, requestMeta(request));
  }

  @Post(':id/reset-password')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: generatedPasswordSchema })
  @ApiOkResponse({ description: 'The new password, once', standardSchema: generatedPasswordSchema })
  resetPassword(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.testCustomers.resetPassword(admin.id, id, requestMeta(request));
  }
}
