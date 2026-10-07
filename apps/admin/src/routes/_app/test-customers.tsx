import { createFileRoute } from '@tanstack/react-router';
import { TestCustomersPage } from '../../features/customers/test-customers-page';

export const Route = createFileRoute('/_app/test-customers')({
  component: TestCustomersPage,
});
