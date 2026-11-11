import { useId } from 'preact/hooks';
import { cx } from './cx.ts';
import { Spinner } from './Spinner.tsx';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What the switch turns on, sentence case ("Record this camera"). */
  label: string;
  /** One short muted line under the label. */
  description?: string;
  disabled?: boolean;
  /** Shows a spinner in place of the switch while a change is being saved. */
  busy?: boolean;
  id?: string;
  /** Render as a row of a GroupedList (wraps itself in the list item). */
  inList?: boolean;
  class?: string;
}

/** An on/off row: label and description on the left, the switch on the right; the whole row is the tap target. */
export function Toggle({ checked, onChange, label, description, disabled = false, busy = false, id, inList = false, class: className }: ToggleProps) {
  const autoId = useId();
  const descriptionId = `${id ?? `t${autoId}`}-desc`;
  const row = (
    <button
      type="button"
      role="switch"
      id={id}
      class={cx('toggle-row', !inList && className)}
      aria-checked={checked ? 'true' : 'false'}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy ? 'true' : undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span class="toggle-text">
        <span class="toggle-label">{label}</span>
        {description && (
          <span id={descriptionId} class="toggle-description">
            {description}
          </span>
        )}
      </span>
      {busy ? <Spinner size={20} decorative /> : <span class="switch" aria-hidden="true" />}
    </button>
  );
  if (!inList) return row;
  return <li class={cx('list-row', className)}>{row}</li>;
}
