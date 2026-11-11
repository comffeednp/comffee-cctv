import type { ComponentChildren } from 'preact';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

export interface EmptyStateProps {
  icon?: IconName;
  /** What is missing, short ("No cameras yet"). */
  title: string;
  /** One line inviting the next step ("Add a camera to start watching and recording."). */
  message?: string;
  /** Usually one primary Button. */
  action?: ComponentChildren;
  class?: string;
}

/** A centred placeholder for an empty list or page, with the action that fills it. */
export function EmptyState({ icon = 'info', title, message, action, class: className }: EmptyStateProps) {
  return (
    <div class={cx('empty-state', className)}>
      <span class="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={32} />
      </span>
      <p class="k-h6">{title}</p>
      {message && <p class="empty-state-message">{message}</p>}
      {action && <div class="empty-state-action">{action}</div>}
    </div>
  );
}
