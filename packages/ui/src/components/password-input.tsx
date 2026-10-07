'use client';

import type { Input as InputPrimitive } from '@base-ui/react/input';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Input } from './input';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

type PasswordInputProps = Omit<InputPrimitive.Props, 'type'> & {
  /** Accessible names of the reveal button; the app passes translated text. */
  showLabel: string;
  hideLabel: string;
};

/**
 * A password input with a button that shows or hides what was typed. Passwords are written left
 * to right, so the whole control is LTR, like every LTR field; the button sits at its left edge.
 */
function PasswordInput({ className, showLabel, hideLabel, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? hideLabel : showLabel;
  return (
    <div data-slot="password-input" dir="ltr" className="relative w-full">
      <Input
        type={visible ? 'text' : 'password'}
        dir="ltr"
        className={cn('ps-10', className)}
        {...props}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute inset-y-0 start-0.5 my-auto text-muted-foreground"
              aria-label={label}
              aria-pressed={visible}
              disabled={props.disabled}
              onClick={() => setVisible((shown) => !shown)}
            />
          }
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export { PasswordInput };
