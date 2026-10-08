// Public surface of the deposits module. Code outside this folder imports from here only.

export {
  DepositReviewService,
  type TelegramDecision,
  type TelegramDecisionRefusal,
  type TelegramDepositFacts,
} from './deposit-review.service.js';
export { DepositsModule } from './deposits.module.js';
