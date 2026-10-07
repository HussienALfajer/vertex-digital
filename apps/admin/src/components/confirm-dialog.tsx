import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@vertex-digital/ui';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../lib/errors';
import { FormAlert } from './form-alert';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  action: string;
  destructive?: boolean;
  pending: boolean;
  /** Runs the action; the dialog closes when it resolves and shows the error when it throws. */
  onConfirm: () => Promise<void>;
  /** Says more about a failure than its code's message (the records it names); else undefined. */
  describeFailure?: (error: unknown) => string | undefined;
  /** Options of the action, under the body. */
  children?: ReactNode;
  /** Where the focus goes when it closes, when the element that opened it is gone (a menu item). */
  finalFocus?: ComponentProps<typeof AlertDialogContent>['finalFocus'];
}

/** Asks before an action that changes a record, and shows why it failed. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  action,
  destructive,
  pending,
  onConfirm,
  describeFailure,
  children,
  finalFocus,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      // After the exit animation, so the failure does not vanish while the dialog fades.
      onOpenChangeComplete={(next) => !next && setFailure(null)}
    >
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {failure && <FormAlert>{failure}</FormAlert>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {t('common.cancel')}
          </AlertDialogClose>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            disabled={pending}
            onClick={async () => {
              setFailure(null);
              try {
                await onConfirm();
                onClose();
              } catch (error) {
                setFailure(describeFailure?.(error) ?? errorMessage(t, error));
              }
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
