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
  Res,
  SerializeOptions,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  type AdminOrderListQuery,
  adminOrderCountsSchema,
  adminOrderListQuerySchema,
  adminOrderPageSchema,
  adminOrderSchema,
  adminRevealedCodeSchema,
  DELIVERY_PROOF_MAX_BYTES,
  deliveryProofSchema,
  fulfilOrderSchema,
  liveBoardQuerySchema,
  liveBoardSchema,
  type OrderPolicy,
  orderPolicySchema,
  type PollAttempt,
  pollAttemptSchema,
  type RefundOrder,
  type RerouteOrder,
  type RevokeShareLink,
  refundOrderSchema,
  rerouteOptionsSchema,
  rerouteOrderSchema,
  resolveAttemptSchema,
  revokeShareLinkSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { sendImage, uploadBody } from '../files/index.js';
import { OrderActionsService } from './order-actions.service.js';
import { OrderDecisionsService } from './order-decisions.service.js';
import { ShareLinksService } from './share-links.service.js';

const proofUpload = FileInterceptor('file', {
  limits: { fileSize: DELIVERY_PROOF_MAX_BYTES, files: 1, fields: 0 },
});

/**
 * The admin's orders (S08 rules D1–D6, C3): every decision, reveal and policy change needs a
 * recent re-authentication; resolving and refunding take an `Idempotency-Key` (`200` either way:
 * the order as the decision left it). S11: the live room, reroute, the delivery proof and the
 * manual fulfil (`OrderActionsService`), each re-authenticated with its `Idempotency-Key`.
 */
@ApiTags('orders')
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(
    private readonly decisions: OrderDecisionsService,
    private readonly shareLinks: ShareLinksService,
    private readonly actions: OrderActionsService,
  ) {}

  /** S10 rule AD1: removes exposure only, so no re-authentication; audited with the reason. */
  @Post(':id/share-links/:linkId/revoke')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({
    description: 'The order with the link revoked',
    standardSchema: adminOrderSchema,
  })
  revokeShareLink(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Body({ schema: revokeShareLinkSchema }) body: RevokeShareLink,
    @Req() request: Request,
  ) {
    return this.shareLinks.adminRevoke(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      linkId,
      body.reason,
    );
  }

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

  /** S11 rules LR1–LR3: the live room's four columns. */
  @Get('live')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(liveBoardQuerySchema)
  @SerializeOptions({ schema: liveBoardSchema })
  @ApiOkResponse({ description: 'The live board', standardSchema: liveBoardSchema })
  live(@Query({ schema: liveBoardQuerySchema }) query: z.output<typeof liveBoardQuerySchema>) {
    return this.actions.board(query);
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

  /** S11 rule RR2: the routes with their eligibility. */
  @Get(':id/routes')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rerouteOptionsSchema })
  @ApiOkResponse({
    description: 'The routes and why each is or is not eligible',
    standardSchema: rerouteOptionsSchema,
  })
  routes(@Param('id') id: string) {
    return this.actions.routes(id);
  }

  /** S11 rule RR3. */
  @Post(':id/reroute')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({
    description: 'The order sent to the chosen route',
    standardSchema: adminOrderSchema,
  })
  async reroute(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: rerouteOrderSchema }) body: RerouteOrder,
    @Req() request: Request,
  ) {
    const { order } = await this.actions.reroute(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      idempotencyKey,
      body,
    );
    return order;
  }

  /** S11 rule MF2: re-encoded, audited; the fulfil names the returned id. */
  @Post(':id/proof')
  @AdminRoute()
  @Sensitive()
  @UseInterceptors(proofUpload)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: deliveryProofSchema })
  @ApiCreatedResponse({ description: 'The stored proof', standardSchema: deliveryProofSchema })
  uploadProof(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Req() request: Request,
  ) {
    return this.actions.uploadProof(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      file?.buffer,
    );
  }

  @Get(':id/proofs/:fileId')
  @AdminRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'A delivery proof, never cached' })
  async proof(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.actions.proof(id, fileId), 'private, no-store');
  }

  /** S11 rules MF1–MF5. */
  @Post(':id/fulfil')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adminOrderSchema })
  @ApiOkResponse({
    description: 'The order after the manual delivery',
    standardSchema: adminOrderSchema,
  })
  async fulfil(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: fulfilOrderSchema }) body: z.output<typeof fulfilOrderSchema>,
    @Req() request: Request,
  ) {
    const { order } = await this.actions.fulfil(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      idempotencyKey,
      body,
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
