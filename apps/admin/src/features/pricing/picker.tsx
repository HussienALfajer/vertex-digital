import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vertex-digital/ui';

/** A select over labelled values. */
export function Picker({
  label,
  placeholder,
  items,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  items: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
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
