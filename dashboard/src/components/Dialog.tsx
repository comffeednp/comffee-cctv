import type { ComponentChildren, TargetedEvent, TargetedMouseEvent } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Button } from './Button.tsx';
import { FormField } from './FormField.tsx';
import { PasswordInput } from './PasswordInput.tsx';

export interface DialogPasswordField {
  /** Field label ("Your password"). */
  label: string;
  hint?: string;
  autoComplete?: 'current-password' | 'new-password';
}

export interface DialogProps {
  open: boolean;
  /** 72 Bold 16, names the action as a question or verb ("Delete this camera?"). */
  title: string;
  /** One or two short sentences: what happens and whether it can be undone. */
  message?: string;
  /** Extra content between the message and the buttons. */
  children?: ComponentChildren;
  /** The verb on the main button ("Delete camera"). */
  confirmLabel: string;
  /** Main button text while busy ("Deleting..."). */
  busyLabel?: string;
  cancelLabel?: string;
  /** danger = red main button, for actions that remove something. */
  tone?: 'default' | 'danger';
  busy?: boolean;
  /** What went wrong, shown above the buttons. */
  error?: string;
  /** Ask for a password before confirming; the typed value is passed to onConfirm and cleared on close. */
  password?: DialogPasswordField;
  confirmDisabled?: boolean;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}

/**
 * A modal confirm built on the native dialog element (focus is kept inside, Escape cancels). Focus starts
 * on the password field when there is one, otherwise on Cancel, so Enter never confirms by accident.
 */
export function Dialog(props: DialogProps) {
  const { open, title, message, children, confirmLabel, busyLabel, cancelLabel = 'Cancel', tone = 'default', busy = false, error, password, onConfirm, onCancel } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [secret, setSecret] = useState('');
  const autoId = useId();
  const titleId = `d${autoId}-title`;
  const messageId = `d${autoId}-message`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) setSecret('');
  }, [open]);

  function onCancelEvent(event: TargetedEvent<HTMLDialogElement, Event>): void {
    event.preventDefault();
    if (!busy) onCancel();
  }

  function onBackdropClick(event: TargetedMouseEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget && !busy) onCancel();
  }

  function onSubmit(event: TargetedEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    if (busy || props.confirmDisabled || (password && secret === '')) return;
    onConfirm(secret);
  }

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby={titleId}
      aria-describedby={message ? messageId : undefined}
      onCancel={onCancelEvent}
      onClick={onBackdropClick}
    >
      {open && (
        <form class="dialog-form" onSubmit={onSubmit} noValidate>
          <h2 id={titleId} class="k-h6">
            {title}
          </h2>
          {message && (
            <p id={messageId} class="dialog-message">
              {message}
            </p>
          )}
          {children}
          {password && (
            <FormField label={password.label} hint={password.hint}>
              <PasswordInput value={secret} onInput={setSecret} autoComplete={password.autoComplete ?? 'current-password'} autoFocus disabled={busy} />
            </FormField>
          )}
          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
          <div class="dialog-actions">
            <Button variant="ghost" onClick={onCancel} disabled={busy} autoFocus={!password}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              loadingLabel={busyLabel}
              disabled={props.confirmDisabled || (password !== undefined && secret === '')}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
