import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ENV, type Env } from './core/config/env.js';
import { sameOriginOnly } from './core/http/same-origin.js';
import { AuthService, CUSTOMER_AUTH_BASE_PATH } from './modules/auth/index.js';
import { STAFF_AUTH_BASE_PATH, StaffAuthService } from './modules/staff/index.js';

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
  // Better Auth reads its own request bodies, so its handlers go before Nest's body parser, which
  // Nest registers when the app initializes. The staff path is the more specific one: first.
  server.all(`${STAFF_AUTH_BASE_PATH}/*splat`, app.get(StaffAuthService).handler());
  server.all(`${CUSTOMER_AUTH_BASE_PATH}/*splat`, app.get(AuthService).handler());

  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, createOpenApiDocument(app));
  }
}

/** The OpenAPI document, generated from the contracts on each route (ADR 0002). */
export function createOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder().setTitle('Vertex Digital API').setVersion('0.0.0').build();
  return SwaggerModule.createDocument(app, config);
}
