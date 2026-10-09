import { createFileRoute } from '@tanstack/react-router';
import { OrderPolicyPage } from '../../features/orders/policy-page';

export const Route = createFileRoute('/_app/orders/policy')({
  component: OrderPolicyPage,
});
