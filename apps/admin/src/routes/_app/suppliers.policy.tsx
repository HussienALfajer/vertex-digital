import { createFileRoute } from '@tanstack/react-router';
import { PolicyPage } from '../../features/suppliers/policy-page';

export const Route = createFileRoute('/_app/suppliers/policy')({
  component: PolicyPage,
});
