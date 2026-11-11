import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useId } from 'preact/hooks';
import { cx } from './cx.ts';

/** What a FormField tells the control inside it. */
export interface FieldContextValue {
  /** id the control must use, so the label points at it. */
  id: string;
  /** id of the label element (for controls named by aria-labelledby). */
  labelId: string;
  /** ids of the hint and error lines, for aria-describedby. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

/** Read by TextInput, PasswordInput and Select. Explicit props on the control win. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FormFieldProps {
  /** 1-3 words, sentence case, no colon: SAP's colon is drawn by CSS. */
  label: string;
  /** One line under the field saying how the value must look. Hidden while an error shows. */
  hint?: string;
  /** What is wrong and how to fix it. Turns the field edge red. */
  error?: string;
  /** Adds "(optional)" to the label. */
  optional?: boolean;
  /** Marks the control required (screen readers announce it). */
  required?: boolean;
  /** Control id; generated when not given. */
  id?: string;
  /** One control: TextInput, PasswordInput or Select. */
  children: ComponentChildren;
  class?: string;
}

const LABEL_HAS_END_MARK = /[?:.!*]$/;

/** Label above (14 mocha + colon), the control, then one hint or error line (12). */
export function FormField({ label, hint, error, optional = false, required = false, id, children, class: className }: FormFieldProps) {
  const autoId = useId();
  const controlId = id ?? `f${autoId}`;
  const labelId = `${controlId}-label`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const text = optional ? `${label} (optional)` : label;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const value: FieldContextValue = { id: controlId, labelId, describedBy, invalid: Boolean(error), required };
  return (
    <div class={cx('field', className)}>
      <label id={labelId} for={controlId} class={LABEL_HAS_END_MARK.test(text.trim()) ? 'k-label' : 'k-label k-label-colon'}>
        {text}
      </label>
      <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
      {error ? (
        <p id={errorId} class="field-error">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} class="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
