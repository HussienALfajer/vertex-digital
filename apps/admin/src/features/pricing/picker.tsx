import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vertex-digital/ui';
import { ReadFailure } from '../../components/read-failure';

/** The read a picker's items come from: waited for, and its failure shown with a retry. */
interface ItemsRead {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/**
 * A select over labelled values. With `read`, it stays disabled while the items load and a failed
 * read shows with a retry instead of an empty list (audit A05-36).
 */
export function Picker({
  label,
  placeholder,
  items,
  value,
  onChange,
  read,
}: {
  label: string;
  placeholder?: string;
  items: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
  read?: ItemsRead;
}) {
  if (read?.isError) return <ReadFailure error={read.error} onRetry={() => read.refetch()} />;
  return (
    <Select
      items={items}
      value={value}
      disabled={read?.isPending}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
