// Public surface of the admin module. Code outside this folder imports from here only.

export { AdminModule } from './admin.module.js';
export {
  AdminAccountError,
  createAdmin,
  resetAdminPassword,
  resetAdminTwoFactor,
} from './admin-accounts.js';
export {
  ADMIN_AUTH_BASE_PATH,
  ADMIN_AUTH_NEST_PATHS,
  ADMIN_SIGN_IN_LIMITS,
} from './admin-auth.config.js';
export { AdminAuthService, type AdminIdentity } from './admin-auth.service.js';
