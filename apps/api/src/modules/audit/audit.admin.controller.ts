import { Controller, Get, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AuditListQuery,
  auditListQuerySchema,
  auditPageSchema,
} from '@vertex-digital/contracts';
import { AdminRoute } from '../../core/access/index.js';
import { AuditService } from './audit.service.js';

/** `GET /api/admin/audit` (S01 rule A4). */
@ApiTags('audit')
@Controller('admin/audit')
export class AuditAdminController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @AdminRoute()
  @SerializeOptions({ schema: auditPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: auditPageSchema })
  list(@Query({ schema: auditListQuerySchema }) query: AuditListQuery) {
    return this.audit.list(query);
  }
}
