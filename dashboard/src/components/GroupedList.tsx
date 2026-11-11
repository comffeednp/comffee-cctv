import type { ComponentChildren } from 'preact';
import { cx } from './cx.ts';

export interface GroupedListProps {
  /** Accessible name of the list ("Cameras"). */
  label?: string;
  /** ListRow or Toggle (with inList) items. */
  children: ComponentChildren;
  class?: string;
}

/** One rounded surface of rows split by hairlines. Hubs and settings pages put their rows in these. */
export function GroupedList({ label, children, class: className }: GroupedListProps) {
  return (
    <ul class={cx('grouped-list', className)} role="list" aria-label={label}>
      {children}
    </ul>
  );
}
