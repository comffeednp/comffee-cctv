import type { TargetedKeyboardEvent } from 'preact';
import { useRef } from 'preact/hooks';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

export interface SegmentOption<T extends string> {
  value: T;
  /** One word, sentence case. Always given: it is the accessible name even when hidden. */
  label: string;
  icon?: IconName;
  /** Show only the icon (the label becomes the tooltip and accessible name). */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group ("View", "Quality"). */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Stretch to the container width with equal segments. */
  block?: boolean;
  /** s = 36 px tall, for toolbars over content; m = 44 px (default). */
  size?: 's' | 'm';
  disabled?: boolean;
  class?: string;
}

/** Two to four mutually exclusive choices in one control (a radio group). Arrow keys move and choose. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  block = false,
  size = 'm',
  disabled = false,
  class: className,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function onKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const step = forward ? 1 : -1;
    for (let n = 1; n <= options.length; n++) {
      const i = (currentIndex + step * n + options.length) % options.length;
      if (!options[i].disabled) {
        onChange(options[i].value);
        const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons?.[i]?.focus();
        return;
      }
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      class={cx('segmented', block && 'segmented-block', size === 's' && 'segmented-s', className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option, i) => {
        const checked = i === currentIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            class="segmented-option"
            aria-checked={checked ? 'true' : 'false'}
            aria-label={option.iconOnly ? option.label : undefined}
            title={option.label}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {option.icon && <Icon name={option.icon} size={18} />}
            {!option.iconOnly && <span>{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
