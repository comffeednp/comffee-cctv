import { cx } from './cx.ts';

export interface SpinnerProps {
  size?: 16 | 20 | 24 | 32;
  /** Read by screen readers. Defaults to "Loading". */
  label?: string;
  /** Hide from screen readers when the text next to it already says what is happening. */
  decorative?: boolean;
  class?: string;
}

/** A small turning ring in the accent colour (a still ring when reduced motion is on). */
export function Spinner({ size = 20, label = 'Loading', decorative = false, class: className }: SpinnerProps) {
  const dims = { width: `${size}px`, height: `${size}px` };
  if (decorative) return <span class={cx('spinner', className)} style={dims} aria-hidden="true" />;
  return (
    <span role="status" class={cx('spinner', className)} style={dims}>
      <span class="sr-only">{label}</span>
    </span>
  );
}
