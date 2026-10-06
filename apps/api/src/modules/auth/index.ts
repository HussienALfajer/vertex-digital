// Public surface of the auth module. Code outside this folder imports from here only.
export { CUSTOMER_AUTH_BASE_PATH } from './auth.config.js';
export { AuthModule } from './auth.module.js';
export { AuthService, type CustomerIdentity } from './auth.service.js';
