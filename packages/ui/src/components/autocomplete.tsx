'use client';

import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete';
import { type Ref, useState } from 'react';
import { cn } from '../lib/cn';
import { popupMotion } from '../lib/motion';

interface AutocompleteProps {
  id?: string;
  name?: string;
  value: string;
  onValueChange: (value: string) => void;
  onBlur?: () => void;
  /** Values already in use, offered as the user types; any other text is accepted too. */
  suggestions: readonly string[];
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Free text with suggestions, such as a sector: picking one keeps spellings consistent. */
function Autocomplete({
  id,
  name,
  value,
  onValueChange,
  onBlur,
  suggestions,
  placeholder,
  invalid,
  disabled,
  className,
  inputRef,
}: AutocompleteProps) {
  const [open, setOpen] = useState(false);
  // An open popup hides the rest of the page from assistive technology, so it opens only when
  // there is something to suggest: a value in use that contains the text and is not the text.
  const typed = value.trim().toLocaleLowerCase();
  const hasMatches = suggestions.some((suggestion) => {
    const lower = suggestion.toLocaleLowerCase();
    return lower.includes(typed) && lower !== typed;
  });
  return (
    <AutocompletePrimitive.Root
      items={suggestions}
      value={value}
      onValueChange={onValueChange}
      open={open && hasMatches}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <AutocompletePrimitive.Input
        ref={inputRef}
        id={id}
        name={name}
        placeholder={placeholder}
        onBlur={onBlur}
        aria-invalid={invalid || undefined}
        data-slot="autocomplete"
        className={cn(
          'h-9 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-base text-foreground',
          'transition-colors duration-150 ease-out placeholder:text-muted-foreground',
          'data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive-text',
          className,
        )}
      />
      <AutocompletePrimitive.Portal>
        <AutocompletePrimitive.Positioner sideOffset={4} className="z-50 outline-none">
          <AutocompletePrimitive.Popup
            data-slot="autocomplete-content"
            className={cn(
              'max-h-[min(var(--available-height),16rem)] w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg border border-border bg-surface p-1 text-surface-foreground shadow-float outline-none',
              popupMotion,
            )}
          >
            <AutocompletePrimitive.List>
              {(item: string) => (
                <AutocompletePrimitive.Item
                  key={item}
                  value={item}
                  className="flex cursor-default items-center rounded-sm px-2 py-1.5 text-base outline-none select-none data-highlighted:bg-muted"
                >
                  {item}
                </AutocompletePrimitive.Item>
              )}
            </AutocompletePrimitive.List>
          </AutocompletePrimitive.Popup>
        </AutocompletePrimitive.Positioner>
      </AutocompletePrimitive.Portal>
    </AutocompletePrimitive.Root>
  );
}

export { Autocomplete, type AutocompleteProps };
