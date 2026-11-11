import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';

export interface CopyBoxProps {
  /** The exact text to show and copy (a setup code, a token, a router script). */
  value: string;
  /** What the value is ("Setup code"). Read by screen readers and used in the button tooltip. */
  label: string;
  /** Keep line breaks and scroll when long (scripts, keys). */
  multiline?: boolean;
  /** Large 20 px digits, for short codes a person types elsewhere. */
  code?: boolean;
  /** Button text; defaults to "Copy", then "Copied" for two seconds. */
  copyLabel?: string;
  copiedLabel?: string;
  onCopy?: () => void;
  class?: string;
}

async function writeClipboard(text: string, fallbackNode: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Falls through to the selection copy below.
  }
  if (!fallbackNode) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(fallbackNode);
  selection.removeAllRanges();
  selection.addRange(range);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  return ok;
}

/** A monospace block holding a value to copy, with a Copy button that confirms with "Copied". */
export function CopyBox({ value, label, multiline = false, code = false, copyLabel = 'Copy', copiedLabel = 'Copied', onCopy, class: className }: CopyBoxProps) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<HTMLPreElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    const ok = await writeClipboard(value, valueRef.current);
    if (!ok) return;
    setCopied(true);
    onCopy?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div class={cx('copy-box', multiline && 'copy-box-multiline', code && 'copy-box-code', className)}>
      <pre ref={valueRef} class="copy-box-value" aria-label={label} tabIndex={multiline ? 0 : undefined}>
        {value}
      </pre>
      <Button variant="ghost" icon={copied ? 'check' : 'copy'} title={`Copy ${label.toLowerCase()}`} onClick={copy}>
        {copied ? copiedLabel : copyLabel}
      </Button>
      <span class="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ''}
      </span>
    </div>
  );
}
