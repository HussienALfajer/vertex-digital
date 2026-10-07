import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '../lib/clipboard';

/** An icon button that copies `value` (an id, a password), with its label as the tooltip. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const { copy, copied } = useCopy();
  const text = copied ? t('common.copied') : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={text}
            onClick={(event) => {
              // Inside a clickable row: copying does not open the row.
              event.stopPropagation();
              void copy(value);
            }}
          />
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
