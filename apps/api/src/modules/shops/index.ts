// Public surface of the shops module. Code outside this folder imports from here only.

export { ShopAccountsService } from './shop-accounts.service.js';
export { SHOP_AUTH_NEST_PATHS } from './shop-auth.config.js';
export { ShopAuthService, type ShopCustomerIdentity } from './shop-auth.service.js';
// The local seed's shop (`cli/seed/shops.ts`) takes an invitation token as the email would.
export { issueInvitation } from './shop-codes.js';
export { ShopsModule } from './shops.module.js';
export { ShopsAdminService } from './shops-admin.service.js';
export { ShopsMerchantService } from './shops-merchant.service.js';
