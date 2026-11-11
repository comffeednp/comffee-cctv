import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { cx } from './cx.ts';

export interface SectionProps {
  /** h2 text: 1-4 words, sentence case. */
  title: string;
  /** One line under the heading saying what the section holds. */
  lead: string;
  /** Buttons on the right of the heading. */
  actions?: ComponentChildren;
  /** 2 (default) for a page section; 3 for a section nested inside another. */
  level?: 2 | 3;
  id?: string;
  children?: ComponentChildren;
  class?: string;
}

/** A page block: heading (h2, 72 Bold 20) + one-line lead (14 mocha), then its content 16 px below. */
export function Section({ title, lead, actions, level = 2, id, children, class: className }: SectionProps) {
  const autoId = useId();
  const headingId = `${id ?? autoId}-title`;
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section id={id} class={cx('section', className)} aria-labelledby={headingId}>
      <div class="section-head">
        <div class="section-titles">
          <Heading id={headingId} class={level === 3 ? 'k-h6' : 'k-title2'}>
            {title}
          </Heading>
          <p class="section-lead">{lead}</p>
        </div>
        {actions && <div class="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
