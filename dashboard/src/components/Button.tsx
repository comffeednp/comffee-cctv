import type { ComponentChildren, TargetedMouseEvent } from 'preact';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { useLinkClick } from './navigation.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  children: ComponentChildren;
  /** primary = the one amber action on a screen; secondary = amber text on a hairline; ghost = no rim; danger = red, for delete-type actions. */
  variant?: ButtonVariant;
  /** m = 44 px tall (default); l = 56 px, for the single main action of a flow step. */
  size?: 'm' | 'l';
  type?: 'button' | 'submit' | 'reset';
  /** Leading icon. */
  icon?: IconName;
  /** Shows a spinner, disables the button and swaps the text for `loadingLabel` when given ("Saving..."). */
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  /** Stretches to the full width of its container. */
  block?: boolean;
  /** Renders a link styled as a button. In-app paths go through the router (NavigationContext). */
  href?: string;
  download?: string | boolean;
  target?: '_blank' | '_self';
  /** Submit a form elsewhere on the page by its id. */
  form?: string;
  name?: string;
  value?: string;
  /** Tooltip; defaults to the text when it is a plain string. */
  title?: string;
  id?: string;
  autoFocus?: boolean;
  'aria-describedby'?: string;
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
  onClick?: (event: TargetedMouseEvent<HTMLElement>) => void;
  class?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'key-cap key-cap-primary',
  secondary: 'key-cap',
  ghost: 'key-cap key-cap-ghost',
  danger: 'key-cap key-cap-danger',
};

/** The SAP-shaped button: 8 px corners, 72 Semibold 14 (Bold on primary), sentence-case verb as text. */
export function Button(props: ButtonProps) {
  const {
    children,
    variant = 'secondary',
    size = 'm',
    type = 'button',
    icon,
    loading = false,
    loadingLabel,
    disabled = false,
    block = false,
    href,
    download,
    target,
    form,
    name,
    value,
    title,
    id,
    autoFocus,
    onClick,
    class: className,
  } = props;
  const handleLinkClick = useLinkClick<HTMLElement>(href, onClick);
  const classes = cx(VARIANT_CLASS[variant], size === 'l' && 'key-cap-l', block && 'key-cap-block', className);
  const tooltip = title ?? (typeof children === 'string' ? children : undefined);
  const content = (
    <>
      {loading ? <Spinner size={16} decorative /> : icon ? <Icon name={icon} size={18} /> : null}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </>
  );

  if (href && !disabled && !loading) {
    return (
      <a
        id={id}
        class={classes}
        href={href}
        download={download}
        target={target}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        title={tooltip}
        aria-describedby={props['aria-describedby']}
        onClick={handleLinkClick}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      id={id}
      class={classes}
      type={type}
      form={form}
      name={name}
      value={value}
      title={tooltip}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
      aria-describedby={props['aria-describedby']}
      aria-controls={props['aria-controls']}
      aria-expanded={props['aria-expanded']}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
