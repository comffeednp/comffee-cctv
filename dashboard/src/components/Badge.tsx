import type { ComponentChildren } from 'preact';
import { cx } from './cx.ts';

/** neutral = mocha; amber = needs a person; ok = live or fine; error = failed only; count = a number. */
export type BadgeTone = 'neutral' | 'amber' | 'ok' | 'error' | 'count';

export interface BadgeProps {
  tone?: BadgeTone;
  /** xs = 12 px text (default); s = 14 px. */
  size?: 'xs' | 's';
  children: ComponentChildren;
  class?: string;
}

/** A status word or a count in a pill. One or two words, sentence case. */
export function Badge({ tone = 'neutral', size = 'xs', children, class: className }: BadgeProps) {
  return (
    <span class={cx('badge', tone !== 'neutral' && `badge-${tone}`, size === 's' && 'badge-s', className)}>{children}</span>
  );
}
