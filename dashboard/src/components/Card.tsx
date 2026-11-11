import type { ComponentChildren } from 'preact';
import { cx } from './cx.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

export interface CardProps {
  /** 72 Bold 16, sentence case, 1-4 words. */
  title?: string;
  /** One muted line under the title. */
  subtitle?: string;
  /** Mocha icon before the title. */
  icon?: IconName;
  /** Heading level of the title: 3 inside a Section (default), 2 when the card is itself a page section. */
  headingLevel?: 2 | 3 | 4;
  /** Buttons on the right of the title. */
  actions?: ComponentChildren;
  /** flush = no inner padding and clipped corners (for a video or a full-bleed list). */
  flush?: boolean;
  children?: ComponentChildren;
  class?: string;
}

/** One surface that groups ONE thing (a camera, a form, a notice). Never a card inside a card. */
export function Card({ title, subtitle, icon, headingLevel = 3, actions, flush = false, children, class: className }: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 4 ? 'h4' : 'h3';
  const hasHead = Boolean(title || actions);
  return (
    <div class={cx('card', flush && 'card-flush', className)}>
      {hasHead && (
        <div class="card-head">
          {icon && <Icon name={icon} size={20} />}
          <div class="card-titles">
            {title && <Heading class="k-h6">{title}</Heading>}
            {subtitle && <p class="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div class="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
