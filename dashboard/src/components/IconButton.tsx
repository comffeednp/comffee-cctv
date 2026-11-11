import type { TargetedMouseEvent } from 'preact';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { useLinkClick } from './navigation.ts';
import { Spinner } from './Spinner.tsx';

export type IconButtonVariant = 'quiet' | 'secondary' | 'danger' | 'overlay';

export interface IconButtonProps {
  icon: IconName;
  /** What the button does ("Full screen", "Copy setup code"). Used as the accessible name and the tooltip. */
  label: string;
  /** quiet = mocha icon, fill on hover (default); secondary = amber icon on a hairline; danger = red icon; overlay = on top of video. */
  variant?: IconButtonVariant;
  /** m = 44 px (default); s = 36 px, only inside a field or a dense row. */
  size?: 'm' | 's';
  /** For on/off buttons (mute, pause): sets aria-pressed and the pressed look. */
  pressed?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  href?: string;
  id?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-haspopup'?: 'menu' | 'listbox' | 'dialog' | 'true';
  onClick?: (event: TargetedMouseEvent<HTMLElement>) => void;
  class?: string;
}

/** A square icon-only button with a required label. */
export function IconButton(props: IconButtonProps) {
  const {
    icon,
    label,
    variant = 'quiet',
    size = 'm',
    pressed,
    loading = false,
    disabled = false,
    type = 'button',
    href,
    id,
    onClick,
    class: className,
  } = props;
  const handleLinkClick = useLinkClick<HTMLElement>(href, onClick);
  const classes = cx('icon-btn', size === 's' && 'icon-btn-s', variant !== 'quiet' && `icon-btn-${variant}`, className);
  const iconSize = size === 's' ? 18 : 20;
  const glyph = loading ? <Spinner size={16} decorative /> : <Icon name={icon} size={iconSize} />;

  if (href && !disabled) {
    return (
      <a id={id} class={classes} href={href} aria-label={label} title={label} onClick={handleLinkClick}>
        {glyph}
      </a>
    );
  }
  return (
    <button
      id={id}
      type={type}
      class={classes}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed ? 'true' : 'false'}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-haspopup={props['aria-haspopup']}
      aria-busy={loading ? 'true' : undefined}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}
