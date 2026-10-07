import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '../lib/cn';
import { popupMotion } from '../lib/motion';

/**
 * A short label shown on hover or keyboard focus, for icon-only buttons. It repeats the button's
 * accessible name for sighted users; it never carries information the button lacks.
 */
const Tooltip = TooltipPrimitive.Root;

/** Opens after 150 ms (Base UI waits 600 ms), quick enough to read as a response to the hover. */
function TooltipTrigger({ delay = 150, ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" delay={delay} {...props} />;
}

function TooltipContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner className="z-50" side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'max-w-64 rounded-md bg-foreground px-2.5 py-1.5 text-sm text-background shadow-float',
            popupMotion,
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
