import type { ComponentChildren, TargetedMouseEvent } from 'preact';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { useLinkClick } from './navigation.ts';

export interface ListRowProps {
  /** 72 Bold 16, sentence case. */
  title: string;
  /** One muted 14 line under the title. */
  secondary?: string;
  /** Mocha icon at the start (20 px). Use `leading` instead for a custom node. */
  icon?: IconName;
  leading?: ComponentChildren;
  /** Right-aligned plain value ("3 cameras", "On"), tabular figures. */
  value?: string;
  /** Right-side node before the chevron (a Badge, a StatusDot, a button). */
  trailing?: ComponentChildren;
  /** Makes the row a link (one row = one destination). */
  href?: string;
  /** Makes the row a button. */
  onClick?: (event: TargetedMouseEvent<HTMLElement>) => void;
  /** Shows the chevron. Defaults to true when the row has href or onClick. */
  chevron?: boolean;
  /** danger = red title and icon (destructive rows go last, in their own GroupedList); amber = amber icon. */
  tone?: 'default' | 'danger' | 'amber';
  /** Highlights the row (the open item of a list). */
  selected?: boolean;
  disabled?: boolean;
  /** Tooltip; defaults to the title. */
  linkTitle?: string;
  class?: string;
}

/** One row of a GroupedList: icon, title + secondary line, value, trailing node, chevron. 56 px minimum. */
export function ListRow(props: ListRowProps) {
  const { title, secondary, icon, leading, value, trailing, href, onClick, tone = 'default', selected = false, disabled = false } = props;
  const handleLinkClick = useLinkClick<HTMLElement>(href, onClick);
  const interactive = Boolean(href || onClick);
  const showChevron = props.chevron ?? interactive;
  const inner = (
    <>
      {leading ?? (icon && <Icon name={icon} size={20} class="list-row-icon" />)}
      <span class="list-row-text">
        <span class="list-row-title">{title}</span>
        {secondary && <span class="list-row-secondary">{secondary}</span>}
      </span>
      {value !== undefined && <span class="list-row-value">{value}</span>}
      {(trailing || showChevron) && (
        <span class="list-row-trailing">
          {trailing}
          {showChevron && <Icon name="chevron" size={16} class="list-row-chevron" />}
        </span>
      )}
    </>
  );
  const rowClass = cx('list-row', tone !== 'default' && `list-row-${tone}`, selected && 'list-row-selected', props.class);
  const tooltip = props.linkTitle ?? title;

  if (href && !disabled) {
    return (
      <li class={rowClass}>
        <a class="list-row-inner" href={href} title={tooltip} aria-current={selected ? 'true' : undefined} onClick={handleLinkClick}>
          {inner}
        </a>
      </li>
    );
  }
  if (onClick || (href && disabled)) {
    return (
      <li class={rowClass}>
        <button
          type="button"
          class="list-row-inner"
          title={tooltip}
          aria-current={selected ? 'true' : undefined}
          disabled={disabled}
          onClick={onClick}
        >
          {inner}
        </button>
      </li>
    );
  }
  return (
    <li class={rowClass}>
      <div class="list-row-inner">{inner}</div>
    </li>
  );
}
