import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

/**
 * Global toast manager: `toast.add({ title, description, type })` from anywhere, where `type` is
 * `success`, `error`, `warning`, `info` or `loading`. `actionProps: { children, onClick }` adds a
 * button under the text (a notification's "Open").
 */
const toast = ToastPrimitive.createToastManager();

const icons: Record<string, ReactNode> = {
  success: <CircleCheckIcon className="text-status-success-foreground" />,
  error: <OctagonXIcon className="text-destructive-text" />,
  warning: <TriangleAlertIcon className="text-status-warning-foreground" />,
  info: <InfoIcon className="text-status-info-foreground" />,
  loading: <Loader2Icon className="animate-spin text-muted-foreground" />,
};

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      data-slot="toast"
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-4 text-surface-foreground shadow-float outline-none',
        'transition-[opacity,translate] duration-200 ease-out',
        'data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0',
      )}
    >
      {item.type && icons[item.type] && (
        <span className="mt-0.5 flex shrink-0 [&_svg]:size-5">{icons[item.type]}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ToastPrimitive.Title className="text-base font-medium" />
        <ToastPrimitive.Description className="text-sm text-muted-foreground" />
        {item.actionProps && (
          <ToastPrimitive.Action
            render={<Button variant="outline" size="sm" className="mt-1 self-start" />}
          />
        )}
      </div>
      <ToastPrimitive.Close
        aria-label={closeLabel}
        render={<Button variant="ghost" size="icon-sm" className="-me-1 -mt-1" />}
      >
        <XIcon />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

interface ToasterProps extends Omit<ToastPrimitive.Provider.Props, 'toastManager'> {
  /** Accessible name of each toast's close button. */
  closeLabel: string;
}

/** Wrap the app once; toasts stack at the bottom, on the inline-end side. */
function Toaster({ children, closeLabel, ...props }: ToasterProps) {
  return (
    <ToastPrimitive.Provider toastManager={toast} {...props}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm flex-col gap-2 outline-none sm:start-auto sm:end-4 sm:mx-0 sm:w-full"
        >
          <ToastList closeLabel={closeLabel} />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { Toaster, toast };
