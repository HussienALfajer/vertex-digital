import { createFileRoute } from '@tanstack/react-router';
import { RatesPage } from '../../features/rates/rates-page';

export const Route = createFileRoute('/_app/rates')({
  component: RatesPage,
});
