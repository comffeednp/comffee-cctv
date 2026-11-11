import type { ComponentChildren } from 'preact';
import { Icon } from './Icons.tsx';
import { useLinkClick } from './navigation.ts';

export interface PageHeaderProps {
  /** The page's one h1: 1-4 words, sentence case, no full stop ("Recordings"). */
  title: string;
  /** One visible line under the title saying what the page is for. */
  subtitle: string;
  /** Optional amber line above the title that adds context the title does not repeat. */
  caption?: string;
  /** A Badge or StatusDot shown beside the title. */
  status?: ComponentChildren;
  /** Buttons on the right (wraps under the title on phones). */
  actions?: ComponentChildren;
  /** A quiet back link above the title, for sub-pages. */
  back?: { href: string; label: string };
}

function BackLink({ href, label }: { href: string; label: string }) {
  const onClick = useLinkClick<HTMLAnchorElement>(href);
  return (
    <a class="page-header-back" href={href} title={label} onClick={onClick}>
      <Icon name="chevron-left" size={18} />
      <span>{label}</span>
    </a>
  );
}

/** The top of every page: optional back link and caption, the h1, one subtitle line, then actions. */
export function PageHeader({ title, subtitle, caption, status, actions, back }: PageHeaderProps) {
  return (
    <header class="page-header">
      {back && <BackLink href={back.href} label={back.label} />}
      <div class="page-header-top">
        <div class="page-header-titles">
          {caption && <p class="k-caption">{caption}</p>}
          <div class="page-header-titleline">
            <h1 class="k-h1">{title}</h1>
            {status}
          </div>
          <p class="k-lead">{subtitle}</p>
        </div>
        {actions && <div class="page-header-actions">{actions}</div>}
      </div>
    </header>
  );
}
