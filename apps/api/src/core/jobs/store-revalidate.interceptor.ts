import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { type Database, queueStoreRevalidate, withoutQueryParameters } from '@vertex-digital/db';
import type { Request } from 'express';
import { type Observable, tap } from 'rxjs';
import { DATABASE } from '../database/database.module.js';
import { JobsService } from './jobs.service.js';

/**
 * S09 rule SF4 for the panel: after an admin change that succeeded on a controller whose data the
 * store shows (catalog, prices, routes, suppliers, the rate), queue `store.revalidate`, at most one
 * per 10 seconds. It runs after the change committed; a failure to queue is logged, never the
 * admin's error, since the store's 5-minute cache life refreshes the pages anyway.
 */
@Injectable()
export class StoreRevalidateInterceptor implements NestInterceptor {
  private readonly logger = new Logger(StoreRevalidateInterceptor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const method = context.switchToHttp().getRequest<Request>().method;
    if (method === 'GET' || method === 'HEAD') return next.handle();
    return next.handle().pipe(
      tap(() => {
        this.db
          .transaction((tx) => queueStoreRevalidate(tx, this.jobs))
          .catch((error: unknown) =>
            this.logger.warn({ err: withoutQueryParameters(error) }, 'store.revalidate not queued'),
          );
      }),
    );
  }
}
