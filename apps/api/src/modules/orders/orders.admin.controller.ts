import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AdminOrderListQuery,
  adminOrderCountsSchema,
  adminOrderListQuerySchema,
  adminOrderPageSchema,
  adminOrderSchema,
  adminRevealedCodeSchema,
  type OrderPolicy,
  orderPolicySchema,
  type PollAttempt,
  pollAttemptSchema,
  type RefundOrder,
  refundOrderSchema,
  resolveAttemptSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { OrderDecisionsService } from './order-decisions.service.js';

/**
 * The admin's orders (S08 rules D1–D6, C3): every decision, reveal and policy change needs a
 * recent re-authentication; resolving and refunding take an `Idempotency-Key` (`200` either way:
 * the order as the decision left it).
 */
@ApiTags('orders')
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(private readonly decisions: OrderDecisionsService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(adminOrderListQuerySchema)
  @SerializeOptions({ schema: adminOrderPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: adminOrderPageSchema })
  list(@Query({ schema: adminOrderListQuerySchema }) query: AdminOrderListQuery) {
    return this.decisions.list(query);
  }

  @Get('counts')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminOrderCountsSchema })
  @ApiOkResponse({ description: 'The navigation badge', standardSchema: adminOrderCountsSchema })
  counts() {
    return this.decisions.counts();
  }

  @Get('policy')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderPolicySchema })
  @ApiOkResponse({ description: 'The policy in force', standardSchema: orderPolicySchema })
  policy() {
    return this.decisions.policy();
  }

  @Put('policy')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderPolicySchema })
  @ApiOkResponse({ description: 'The new policy, in force', standardSchema: orderPolicySchema })
  setPolicy(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: orderPolicySchema }) body: OrderPolicy,
    @Req() request: Request,
  ) {
    return this.decisions.setPolicy({ adminId: admin.id, meta: requestMeta(request) }, body);
  }

  @Get(':id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({ description: 'The order, codes masked', standardSchema: adminOrderSchema })
  order(@Param('id') id: string) {
    return this.decisions.order(id);
  }

  @Post(':id/attempts/:attemptId/poll')
  @AdminRoute()
  @Sensitive()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiAcceptedResponse({ description: 'The poll is queued', standardSchema: adminOrderSchema })
  poll(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
    @Body({ schema: pollAttemptSchema }) body: PollAttempt,
    @Req() request: Request,
  ) {
    return this.decisions.poll(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      attemptId,
      body.reason,
    );
  }

  @Post(':id/attempts/:attemptId/resolve')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({ description: 'The order after the decision', standardSchema: adminOrderSchema })
  async resolve(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: resolveAttemptSchema }) body: z.output<typeof resolveAttemptSchema>,
    @Req() request: Request,
  ) {
    const { order } = await this.decisions.resolve(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      attemptId,
      idempotencyKey,
      body,
    );
    return order;
  }

  @Post(':id/refund')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({ description: 'The refunded order', standardSchema: adminOrderSchema })
  async refund(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: refundOrderSchema }) body: RefundOrder,
    @Req() request: Request,
  ) {
    const { order } = await this.decisions.refund(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      idempotencyKey,
      body.reason,
    );
    return order;
  }

  @Post(':id/codes/:codeId/reveal')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminRevealedCodeSchema })
  @ApiOkResponse({
    description: 'The code; the reveal is logged',
    standardSchema: adminRevealedCodeSchema,
  })
  reveal(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('codeId') codeId: string,
    @Req() request: Request,
  ) {
    return this.decisions.reveal({ adminId: admin.id, meta: requestMeta(request) }, id, codeId);
  }
}
