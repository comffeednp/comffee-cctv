import { cx } from './cx.ts';

export type Status = 'online' | 'offline' | 'recording' | 'paused';

export interface StatusDotProps {
  status: Status;
  /** Visible word next to the dot. Defaults to "Online", "Offline", "Recording" or "Paused". */
  label?: string;
  /** Keep the word for screen readers only (for example over a video tile that already names the state). */
  hideLabel?: boolean;
  class?: string;
}

const DEFAULT_LABEL: Record<Status, string> = {
  online: 'Online',
  offline: 'Offline',
  recording: 'Recording',
  paused: 'Paused',
};

/**
 * A coloured dot plus its word, never a dot alone: online = phosphor, recording = phosphor with a soft
 * pulse, paused = amber (needs a person), offline = red (a failure).
 */
export function StatusDot({ status, label, hideLabel = false, class: className }: StatusDotProps) {
  const text = label ?? DEFAULT_LABEL[status];
  return (
    <span class={cx('status', `status-${status}`, className)}>
      <span class="status-mark" aria-hidden="true" />
      <span class={hideLabel ? 'sr-only' : undefined}>{text}</span>
    </span>
  );
}
