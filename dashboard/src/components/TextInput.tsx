import type { Ref, TargetedFocusEvent, TargetedKeyboardEvent } from 'preact';
import { cx } from './cx.ts';
import { useField } from './FormField.tsx';

export interface TextInputProps {
  value: string;
  /** Called on every keystroke with the new text. */
  onInput: (value: string) => void;
  type?: 'text' | 'email' | 'url' | 'search' | 'tel' | 'number';
  id?: string;
  name?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url' | 'tel' | 'search' | 'none';
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
  autoCapitalize?: 'off' | 'none' | 'sentences' | 'words' | 'characters';
  spellcheck?: boolean;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  /** Monospace text, for addresses, paths and codes. */
  mono?: boolean;
  /** Overrides the FormField's error state. */
  invalid?: boolean;
  /** Accessible name when the input is not inside a FormField. */
  'aria-label'?: string;
  onBlur?: (event: TargetedFocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: TargetedKeyboardEvent<HTMLInputElement>) => void;
  inputRef?: Ref<HTMLInputElement>;
  class?: string;
}

/** A SAP field well: 48 px tall, 4 px corners, value in 14, amber edge on focus. Controlled. */
export function TextInput(props: TextInputProps) {
  const field = useField();
  const { value, onInput, type = 'text', invalid, mono = false, inputRef, class: className } = props;
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      ref={inputRef}
      class={cx('k-field', mono && 'k-field-mono', className)}
      // Preact 11 types each input type separately; every type offered here takes the same props.
      type={type as 'text'}
      id={props.id ?? field?.id}
      name={props.name}
      value={value}
      placeholder={props.placeholder}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      enterkeyhint={props.enterKeyHint}
      autoCapitalize={props.autoCapitalize}
      spellcheck={props.spellcheck}
      required={props.required ?? field?.required}
      disabled={props.disabled}
      readOnly={props.readOnly}
      autoFocus={props.autoFocus}
      maxLength={props.maxLength}
      minLength={props.minLength}
      min={props.min}
      max={props.max}
      step={props.step}
      pattern={props.pattern}
      aria-label={props['aria-label']}
      aria-invalid={isInvalid ? 'true' : undefined}
      aria-describedby={field?.describedBy}
      onInput={(event) => onInput(event.currentTarget.value)}
      onBlur={props.onBlur}
      onKeyDown={props.onKeyDown}
    />
  );
}
