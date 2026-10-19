// Public surface of the deposits module. Code outside this folder imports from here only.

export {
  DepositReviewService,
  type TelegramDecision,
  type TelegramDecisionRefusal,
  type TelegramDepositFacts,
} from './deposit-review.service.js';
export { DepositSettingsService } from './deposit-settings.service.js';
export { DepositsModule } from './deposits.module.js';
export { DepositsService } from './deposits.service.js';
export { UsdtDepositsService } from './usdt-deposits.service.js';
