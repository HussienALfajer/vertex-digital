import { createFileRoute } from '@tanstack/react-router';
import { type StoreSwitch, storeSwitchSchema } from '@vertex-digital/contracts';
import { SwitchesPage } from '../../features/settings/switches-page';

/** The history filter in the URL: one switch, or every switch when absent or unknown. */
function parseSwitchSearch(search: Record<string, unknown>): { switch?: StoreSwitch } {
  const parsed = storeSwitchSchema.safeParse(search.switch);
  return parsed.success ? { switch: parsed.data } : {};
}

export const Route = createFileRoute('/_app/settings/switches')({
  validateSearch: parseSwitchSearch,
  component: SwitchesRoute,
});

function SwitchesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SwitchesPage
      filter={search.switch}
      onFilter={(next) => navigate({ search: () => (next ? { switch: next } : {}) })}
    />
  );
}
