import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type CreateManualRoute,
  createManualRouteSchema,
  createRouteSchema,
  productRoutingSchema,
  setManualCostSchema,
  type UpdateRoute,
  updateRouteSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import type { AdminIdentity } from '../admin/index.js';
import type { Actor } from '../catalog/index.js';
import { RoutesService } from './routes.service.js';

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

/** A product's routes in the panel (S07 rules RT1–RT7): each answer is the product's routing. */
@ApiTags('suppliers')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin')
export class RoutesAdminController {
  constructor(private readonly routes: RoutesService) {}

  @Get('catalog/products/:id/routes')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiOkResponse({ description: 'Routes in tier order', standardSchema: productRoutingSchema })
  routing(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.routes.routing(id);
  }

  @Post('catalog/products/:id/routes')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiCreatedResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  create(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: createRouteSchema }) body: z.output<typeof createRouteSchema>,
    @Req() request: Request,
  ) {
    return this.routes.create(actor(admin, request), id, body);
  }

  /** Rule RT7: a cost the admin enters re-authenticates. */
  @Post('catalog/products/:id/routes/manual')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiCreatedResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  createManual(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: createManualRouteSchema }) body: CreateManualRoute,
    @Req() request: Request,
  ) {
    return this.routes.createManual(actor(admin, request), id, body.costUsdUnits);
  }

  @Patch('routes/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiOkResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  update(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateRouteSchema }) body: UpdateRoute,
    @Req() request: Request,
  ) {
    return this.routes.update(actor(admin, request), id, body);
  }

  @Post('routes/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiOkResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  archive(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.routes.archive(actor(admin, request), id);
  }

  @Post('routes/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiOkResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  restore(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.routes.restore(actor(admin, request), id);
  }

  @Put('routes/:id/manual-cost')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productRoutingSchema })
  @ApiOkResponse({ description: 'The routing', standardSchema: productRoutingSchema })
  setManualCost(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: setManualCostSchema }) body: CreateManualRoute,
    @Req() request: Request,
  ) {
    return this.routes.setManualCost(actor(admin, request), id, body.costUsdUnits);
  }
}
