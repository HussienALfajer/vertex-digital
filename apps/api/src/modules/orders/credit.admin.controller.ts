import { Body, Controller, Get, Header, Put, Req, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type CreditPolicy, creditPolicySchema } from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { CreditService } from './credit.service.js';

/** S25: the credit policy ("حدود الرصيد والكاش"); a change needs a recent re-authentication. */
@ApiTags('orders')
@Controller('admin/credit-policy')
export class CreditAdminController {
  constructor(private readonly credit: CreditService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: creditPolicySchema })
  @ApiOkResponse({ description: 'The policy in force', standardSchema: creditPolicySchema })
  policy() {
    return this.credit.policy();
  }

  @Put()
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: creditPolicySchema })
  @ApiOkResponse({ description: 'The new policy, in force', standardSchema: creditPolicySchema })
  setPolicy(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: creditPolicySchema }) body: CreditPolicy,
    @Req() request: Request,
  ) {
    return this.credit.setPolicy({ adminId: admin.id, meta: requestMeta(request) }, body);
  }
}
