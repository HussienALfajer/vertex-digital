import { createFileRoute } from '@tanstack/react-router';
import { SuppliersPage } from '../../features/suppliers/suppliers-page';

export const Route = createFileRoute('/_app/suppliers/')({
  component: SuppliersPage,
});
