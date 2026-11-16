import { createFileRoute } from '@tanstack/react-router';
import { RateSourcePage } from '../../features/rates/rate-source-page';

export const Route = createFileRoute('/_app/rates/sources/new')({
  component: () => <RateSourcePage />,
});
