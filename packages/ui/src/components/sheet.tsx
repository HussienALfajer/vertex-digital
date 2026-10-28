import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '../lib/cn';
import { Dialog, DialogOverlay, useMarkTyped } from './dialog';

/**
 * A panel sliding in from the inline-start edge (the right in RTL), e.g. navigation on phones, or
 * with `side="bottom"` up from the bottom edge: the store's buy box on phones (§6). Like a dialog,
 * it ignores Escape and a click outside once something was typed in it (audit A10-20).
 */
const Sheet = Dialog;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetTitle = DialogPrimitive.Title;

const SIDES = {
  start: cn(
    'inset-y-0 start-0 w-72 max-w-[85vw]',
    'ltr:data-starting-style:-translate-x-full ltr:data-ending-style:-translate-x-full',
    'rtl:data-starting-style:translate-x-full rtl:data-ending-style:translate-x-full',
  ),
  bottom: cn(
    'inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-xl border-t border-border',
    'data-starting-style:translate-y-full data-ending-style:translate-y-full',
  ),
};

function SheetContent({
  className,
  side = 'start',
  onInput,
  onSubmit,
  ...props
}: DialogPrimitive.Popup.Props & { side?: keyof typeof SIDES }) {
  const markTyped = useMarkTyped(onInput, onSubmit);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col shadow-float outline-none',
          'transition-transform duration-250 ease-out',
          SIDES[side],
          className,
        )}
        {...props}
        {...markTyped}
      />
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger };
