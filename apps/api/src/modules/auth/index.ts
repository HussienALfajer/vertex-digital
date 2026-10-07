// Public surface of the auth module. Code outside this folder imports from here only.
export { CUSTOMER_AUTH_BASE_PATH, CUSTOMER_AUTH_NEST_PATHS } from './auth.config.js';
export { AuthModule } from './auth.module.js';
export { AuthService, type CustomerIdentity } from './auth.service.js';
