import type { CSSProperties, JSX, TargetedKeyboardEvent } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { cx } from './cx.ts';
import { useField } from './FormField.tsx';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

export interface SelectOption<T extends string | number> {
  value: T;
  /** Sentence case, a few words. */
  label: string;
  /** One short muted line under the label. */
  detail?: string;
  icon?: IconName;
  disabled?: boolean;
  /** Options with the same group text, listed one after another, show under that group heading. */
  group?: string;
}

export interface SelectProps<T extends string | number> {
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Shown while nothing is chosen. Defaults to "Choose". */
  placeholder?: string;
  id?: string;
  /** Adds a hidden input with this name, for plain form posts. */
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Accessible name when the Select is not inside a FormField. */
  'aria-label'?: string;
  class?: string;
}

interface Placement {
  side: 'top' | 'bottom';
  left: number;
  width: number;
  offset: number;
  maxHeight: number;
}

const GAP = 4;
const EDGE = 8;
const MAX_HEIGHT = 320;

/**
 * The one dropdown: a field-shaped button that opens a k-popover listbox of k-option rows.
 * Keyboard: Enter, Space or Arrow keys open it; Arrow keys, Home and End move; Enter or Space picks;
 * Escape closes and returns focus; typing letters jumps to a matching option.
 */
export function Select<T extends string | number>(props: SelectProps<T>) {
  const { value, options, onChange, placeholder = 'Choose', disabled = false, class: className } = props;
  const field = useField();
  const autoId = useId();
  const id = props.id ?? field?.id ?? `s${autoId}`;
  const listId = `${id}-list`;
  const valueId = `${id}-value`;
  const optionId = (index: number) => `${id}-opt-${index}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const invalid = props.invalid ?? field?.invalid ?? false;

  function enabledFrom(start: number, step: 1 | -1): number {
    for (let i = start; i >= 0 && i < options.length; i += step) {
      if (!options[i].disabled) return i;
    }
    return -1;
  }

  function measure(): void {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.innerHeight;
    const below = viewport - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const wanted = Math.min(MAX_HEIGHT, options.length * 40 + 8);
    const side = below >= wanted || below >= above ? 'bottom' : 'top';
    const room = side === 'bottom' ? below : above;
    setPlacement({
      side,
      left: rect.left,
      width: rect.width,
      offset: side === 'bottom' ? rect.bottom + GAP : viewport - rect.top + GAP,
      maxHeight: Math.max(120, Math.min(MAX_HEIGHT, room)),
    });
  }

  function openList(startAt?: number): void {
    if (disabled || options.length === 0) return;
    measure();
    setActive(startAt ?? (selectedIndex >= 0 ? selectedIndex : enabledFrom(0, 1)));
    setOpen(true);
  }

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  }

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (event.target !== listRef.current) measure();
    };
    const onResize = () => measure();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  function onTriggerKeyDown(event: TargetedKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowUp' && selectedIndex < 0) openList(enabledFrom(options.length - 1, -1));
      else openList();
    }
  }

  function onListKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const next = key === 'ArrowDown' ? enabledFrom(active + 1, 1) : enabledFrom(active - 1, -1);
      if (next >= 0) setActive(next);
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      const next = key === 'Home' ? enabledFrom(0, 1) : enabledFrom(options.length - 1, -1);
      if (next >= 0) setActive(next);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (active >= 0) choose(active);
    } else if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (key === 'Tab') {
      close(false);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > 700 ? key.toLowerCase() : state.text + key.toLowerCase();
      state.at = now;
      const start = state.text.length > 1 ? Math.max(active, 0) : active + 1;
      for (let step = 0; step < options.length; step++) {
        const i = (start + step) % options.length;
        if (!options[i].disabled && options[i].label.toLowerCase().startsWith(state.text)) {
          setActive(i);
          break;
        }
      }
    }
  }

  const listStyle: CSSProperties | undefined = placement
    ? {
        left: `${placement.left}px`,
        width: `${placement.width}px`,
        maxHeight: `${placement.maxHeight}px`,
        ...(placement.side === 'bottom' ? { top: `${placement.offset}px` } : { bottom: `${placement.offset}px` }),
      }
    : undefined;

  const shownValue = selected ? selected.label : placeholder;
  const ownLabel = props['aria-label'];

  const rows: JSX.Element[] = [];
  let index = 0;
  while (index < options.length) {
    const group = options[index].group;
    const items: JSX.Element[] = [];
    while (index < options.length && options[index].group === group) {
      const i = index;
      const option = options[i];
      items.push(
        <div
          key={`o${i}`}
          id={optionId(i)}
          role="option"
          class="k-option"
          aria-selected={i === selectedIndex ? 'true' : 'false'}
          aria-disabled={option.disabled ? 'true' : undefined}
          data-active={i === active ? 'true' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => {
            if (i !== active && !option.disabled) setActive(i);
          }}
          onClick={() => choose(i)}
        >
          {option.icon && <Icon name={option.icon} size={18} />}
          <span class="k-option-text">
            <span>{option.label}</span>
            {option.detail && <span class="k-option-detail">{option.detail}</span>}
          </span>
          {i === selectedIndex && <Icon name="check" size={18} class="k-option-check" />}
        </div>,
      );
      index++;
    }
    if (group) {
      const groupId = `${id}-group-${rows.length}`;
      rows.push(
        <div key={groupId} role="group" aria-labelledby={groupId}>
          <div id={groupId} class="k-option-group" role="presentation">
            {group}
          </div>
          {items}
        </div>,
      );
    } else {
      rows.push(...items);
    }
  }

  return (
    <div ref={rootRef} class={cx('select', className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        class="k-field select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? listId : undefined}
        aria-labelledby={field && !ownLabel ? `${field.labelId} ${valueId}` : undefined}
        aria-label={ownLabel ? `${ownLabel}, ${shownValue}` : undefined}
        aria-describedby={field?.describedBy}
        aria-invalid={invalid ? 'true' : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={valueId} class={cx('select-value', !selected && 'select-placeholder')}>
          {shownValue}
        </span>
        <Icon name="chevron-down" size={18} class="select-chevron" />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          class="select-popover k-popover"
          data-placement={placement?.side}
          style={listStyle}
          aria-labelledby={field && !ownLabel ? field.labelId : undefined}
          aria-label={ownLabel}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onKeyDown={onListKeyDown}
        >
          {rows}
        </div>
      )}
      {props.name && <input type="hidden" name={props.name} value={value === null ? '' : String(value)} />}
    </div>
  );
}
