import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from 'react';
import { cn } from '../lib/cn';
import { dialogMotion, overlayMotion } from '../lib/motion';
import { Button } from './button';

/** Whether something was typed in the open dialog or sheet (audit A10-20). */
const TypedContext = createContext<RefObject<boolean> | null>(null);

/** Inputs whose change is a value typed, not a choice toggled or a button pressed. */
const UNTYPED_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'hidden',
]);

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !UNTYPED_INPUTS.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * A dialog (or a sheet) closes on Escape or a click outside only while nothing was typed in it
 * since it opened or since its form was last sent: after that only its own buttons close it, so a
 * stray key or click never loses a typed amount, reason or text (audit A10-20, after A03-24,
 * A05-78, A07-55, A08). Toggles and a dialog opened from inside it do not count. `onOpenChange` is
 * not called for a dismissal it refused. `guardTyped={false}` keeps the dismissal for a dialog that
 * has no button of its own to close it, or whose typing is the point (the store's search, its buy
 * box sheet on phones).
 */
function Dialog({
  onOpenChange,
  open,
  guardTyped = true,
  ...props
}: DialogPrimitive.Root.Props & { guardTyped?: boolean }) {
  const typed = useRef(false);
  // A controlled dialog opened or closed through its prop starts clean.
  useEffect(() => {
    if (open !== undefined) typed.current = false;
  }, [open]);
  return (
    <TypedContext.Provider value={typed}>
      <DialogPrimitive.Root
        {...props}
        open={open}
        onOpenChange={(open, details) => {
          const dismissal = details.reason === 'escape-key' || details.reason === 'outside-press';
          if (!open && dismissal && guardTyped && typed.current) {
            details.cancel();
            return;
          }
          typed.current = false;
          onOpenChange?.(open, details);
        }}
      />
    </TypedContext.Provider>
  );
}

type PopupProps = DialogPrimitive.Popup.Props;

/**
 * The popup's `onInput` and `onSubmit`: typing in this popup (not in a dialog portalled from it)
 * marks it, sending its form clears the mark.
 */
function useMarkTyped(onInput?: PopupProps['onInput'], onSubmit?: PopupProps['onSubmit']) {
  const typed = useContext(TypedContext);
  return {
    onInput: (event: Parameters<NonNullable<PopupProps['onInput']>>[0]) => {
      const inside = event.currentTarget.contains(event.target as Node);
      if (typed && inside && isTyping(event.target)) typed.current = true;
      onInput?.(event);
    },
    onSubmit: (event: Parameters<NonNullable<PopupProps['onSubmit']>>[0]) => {
      if (typed && event.currentTarget.contains(event.target as Node)) typed.current = false;
      onSubmit?.(event);
    },
  };
}
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn('fixed inset-0 z-50 bg-overlay', overlayMotion, className)}
      {...props}
    />
  );
}

interface DialogContentProps extends DialogPrimitive.Popup.Props {
  /** Accessible name of the close button; omit it to hide the button. */
  closeLabel?: string;
}

function DialogContent({ className, children, closeLabel, onInput, ...props }: DialogContentProps) {
  const markTyped = useMarkTyped(onInput);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed start-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-y-1/2 gap-4 rounded-xl border border-border bg-surface p-6 text-surface-foreground shadow-float outline-none',
          // A long form scrolls inside the dialog instead of losing its title or its buttons.
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          // Centre on the inline axis in both directions.
          'ltr:-translate-x-1/2 rtl:translate-x-1/2',
          dialogMotion,
          className,
        )}
        {...props}
        {...markTyped}
      >
        {children}
        {closeLabel && (
          <DialogPrimitive.Close
            render={<Button variant="ghost" size="icon-sm" className="absolute end-3 top-3" />}
            aria-label={closeLabel}
          >
            <XIcon />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-1', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-xl font-bold', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-base text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
  useMarkTyped,
};
