import type { Ref, TargetedKeyboardEvent } from 'preact';
import { useState } from 'preact/hooks';
import { cx } from './cx.ts';
import { useField } from './FormField.tsx';
import { IconButton } from './IconButton.tsx';

export interface PasswordInputProps {
  value: string;
  onInput: (value: string) => void;
  /** current-password on sign-in and confirmations; new-password when choosing one. */
  autoComplete?: 'current-password' | 'new-password' | 'off';
  id?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  minLength?: number;
  maxLength?: number;
  invalid?: boolean;
  'aria-label'?: string;
  onKeyDown?: (event: TargetedKeyboardEvent<HTMLInputElement>) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** Name of the show/hide button (a pressed toggle). Defaults to "Show password". */
  showLabel?: string;
  class?: string;
}

/** A password field with a show/hide eye button inside its right edge. */
export function PasswordInput(props: PasswordInputProps) {
  const field = useField();
  const [visible, setVisible] = useState(false);
  const { value, onInput, autoComplete = 'current-password', invalid, inputRef, class: className } = props;
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <div class={cx('field-affix', className)}>
      <input
        ref={inputRef}
        class="k-field"
        type={(visible ? 'text' : 'password') as 'text'}
        id={props.id ?? field?.id}
        name={props.name}
        value={value}
        placeholder={props.placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellcheck={false}
        required={props.required ?? field?.required}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        minLength={props.minLength}
        maxLength={props.maxLength}
        aria-label={props['aria-label']}
        aria-invalid={isInvalid ? 'true' : undefined}
        aria-describedby={field?.describedBy}
        onInput={(event) => onInput(event.currentTarget.value)}
        onKeyDown={props.onKeyDown}
      />
      <IconButton
        icon={visible ? 'eye-off' : 'eye'}
        label={props.showLabel ?? 'Show password'}
        size="s"
        pressed={visible}
        disabled={props.disabled}
        onClick={() => setVisible((v) => !v)}
      />
    </div>
  );
}
