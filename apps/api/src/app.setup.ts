import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ENV, type Env } from './core/config/env.js';
import { sameOriginOnly } from './core/http/same-origin.js';
import {
  ADMIN_AUTH_BASE_PATH,
  ADMIN_AUTH_NEST_PATHS,
  AdminAuthService,
} from './modules/admin/index.js';
import {
  AuthService,
  CUSTOMER_AUTH_BASE_PATH,
  CUSTOMER_AUTH_NEST_PATHS,
} from './modules/auth/index.js';
import { SUPPLIER_WEBHOOK_ROUTE, supplierWebhookBody } from './modules/suppliers/index.js';
import { TELEGRAM_WEBHOOK_PATH, telegramWebhookBodyLimit } from './modules/telegram/index.js';

export const API_PREFIX = 'api';

/** Configuration shared by the real server and the integration tests. */
export function configureApp(app: NestExpressApplication): void {
  const env = app.get<Env>(ENV);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  const server = app.getHttpAdapter().getInstance();
  // Don't advertise the framework in every response.
  server.disable('x-powered-by');
  // nginx on the same machine sets X-Forwarded-For (ADR 0009); nobody else is trusted with it.
  server.set('trust proxy', 'loopback');
  app.use(sameOriginOnly({ store: env.STORE_URL, admin: env.ADMIN_URL }));
  // Before Nest's body parser, which Nest registers when the app initializes.
  server.post(TELEGRAM_WEBHOOK_PATH, telegramWebhookBodyLimit);
  server.post(SUPPLIER_WEBHOOK_ROUTE, supplierWebhookBody);
  // Better Auth reads its own request bodies, so its handlers go before Nest's body parser, which
  // Nest registers when the app initializes. The admin path is the more specific one: first.
  server.all(
    `${ADMIN_AUTH_BASE_PATH}/*splat`,
    betterAuthExcept(
      ADMIN_AUTH_BASE_PATH,
      ADMIN_AUTH_NEST_PATHS,
      app.get(AdminAuthService).handler(),
    ),
  );
  server.all(
    `${CUSTOMER_AUTH_BASE_PATH}/*splat`,
    betterAuthExcept(
      CUSTOMER_AUTH_BASE_PATH,
      CUSTOMER_AUTH_NEST_PATHS,
      app.get(AuthService).handler(),
    ),
  );

  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, createOpenApiDocument(app));
  }
}

/**
 * A Better Auth handler that leaves some of its paths to Nest routes (account changes, audited in
 * their transactions): those requests go on to the Nest router.
 */
function betterAuthExcept(
  basePath: string,
  nestPaths: readonly string[],
  handler: (request: IncomingMessage, response: ServerResponse) => unknown,
) {
  const served = new Set(nestPaths.map((path) => `${basePath}${path}`.toLowerCase()));
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    // A route handler sees the full path; Express matches routes case-insensitively.
    const url = (request as IncomingMessage & { originalUrl?: string }).originalUrl ?? request.url;
    const path = (url ?? '').split('?')[0]?.replace(/[/]+$/, '').toLowerCase() ?? '';
    if (served.has(path)) return next();
    return handler(request, response);
  };
}

/** The OpenAPI document, generated from the contracts on each route (ADR 0002). */
export function createOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder().setTitle('Vertex Digital API').setVersion('0.0.0').build();
  return SwaggerModule.createDocument(app, config);
}
