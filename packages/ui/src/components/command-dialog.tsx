import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '../lib/cn';
import { dialogMotion } from '../lib/motion';
import { DialogOverlay } from './dialog';

/**
 * The popup of a command palette (§11, the store's `Ctrl+K` search): a full-screen sheet on
 * phones, a dialog near the top of the screen from `sm`, so results have room below the field.
 * Use inside `Dialog`; the caller gives it a `DialogTitle` (visually hidden if need be).
 */
function CommandDialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="command-dialog-content"
        className={cn(
          'fixed inset-0 z-50 flex flex-col bg-surface text-surface-foreground outline-none',
          'sm:inset-auto sm:start-1/2 sm:top-[10dvh] sm:max-h-[75dvh] sm:w-[calc(100%-2rem)] sm:max-w-xl',
          'sm:rounded-xl sm:border sm:border-border sm:shadow-float',
          'sm:ltr:-translate-x-1/2 sm:rtl:translate-x-1/2',
          dialogMotion,
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

export { CommandDialogContent };
