import { createFileRoute } from '@tanstack/react-router';
import { CreditPolicyPage } from '../../features/orders/credit-policy-page';

export const Route = createFileRoute('/_app/settings/credit')({
  component: CreditPolicyPage,
});
