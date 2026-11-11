// Desktop-only building blocks, made from the dashboard's components and theme tokens.
import type { ComponentChildren } from 'preact';
import { Button, Card, IconButton, PageHeader, Select, Spinner, cx, useField } from '../../../dashboard/src/components/index.ts';
import type { ServerView } from '../../src/lib/ipc-types.ts';
import { navigate } from '../lib/router.ts';
import { hostOf } from '../lib/format.ts';

export const TOTAL_STEPS = 4;

export function stepLead(step: number, text: string): string {
  return `Step ${step} of ${TOTAL_STEPS}. ${text}`;
}

interface PageProps {
  title: string;
  subtitle: string;
  caption?: string;
  back?: { href: string; label: string };
  children: ComponentChildren;
}

/** A flow step: one narrow column, the header, then one card holding the step. */
export function FlowPage({ title, subtitle, caption, back, children }: PageProps) {
  return (
    <main id="main" tabIndex={-1} class="app-main auth-main">
      <PageHeader caption={caption} title={title} subtitle={subtitle} back={back} />
      <Card>{children}</Card>
    </main>
  );
}

/** A hub or settings page: the header, then sections of grouped lists. */
export function HubPage({ title, subtitle, caption, back, children, narrow = true }: PageProps & { narrow?: boolean }) {
  return (
    <main id="main" tabIndex={-1} class={cx('app-main', narrow && 'auth-main')}>
      <PageHeader caption={caption} title={title} subtitle={subtitle} back={back} />
      {children}
    </main>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div class="app-loading row">
      <Spinner size={24} decorative />
      <span class="k-body-s">{label}</span>
    </div>
  );
}

interface TextAreaProps {
  value: string;
  onInput: (value: string) => void;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** A multi-line field well for pasted text; picks up its id and error state from FormField. */
export function TextArea({ value, onInput, rows = 7, placeholder, autoFocus, disabled }: TextAreaProps) {
  const field = useField();
  return (
    <textarea
      class="k-field k-field-mono desk-textarea"
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid ? 'true' : undefined}
      required={field?.required}
      value={value}
      rows={rows}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      spellcheck={false}
      autoComplete="off"
      onInput={(event) => onInput(event.currentTarget.value)}
    />
  );
}

/** The slim bar above a server's dashboard: server switcher, Add server, Accounts. */
export function TopBar({ servers, currentId }: { servers: ServerView[]; currentId: string | null }) {
  const options = servers.map((s) => ({ value: s.id, label: s.name, detail: s.status === 'installing' ? 'Installing' : hostOf(s) }));
  return (
    <header class="desk-topbar">
      <span class="desk-brand">
        <img src="/icons/icon.svg" alt="" width={24} height={24} />
        <span class="desk-brand-name k-h6">Comffee CCTV</span>
      </span>
      <div class="desk-switcher">
        <Select aria-label="Server" value={currentId} options={options} placeholder="Choose a server" onChange={(id) => navigate(`/server/${id}`)} />
      </div>
      <div class="desk-actions">
        <Button class="desk-wide" variant="ghost" icon="plus" href="/add">
          Add server
        </Button>
        <Button class="desk-wide" variant="ghost" icon="settings" href="/settings">
          Accounts
        </Button>
        <IconButton class="desk-narrow" icon="plus" label="Add server" href="/add" />
        <IconButton class="desk-narrow" icon="settings" label="Accounts" href="/settings" />
      </div>
    </header>
  );
}
