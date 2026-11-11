import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';
import { IconButton } from './IconButton.tsx';
import { Icon } from './Icons.tsx';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  /** One short sentence ("Camera saved."). Errors say what happened and what to do. */
  message: string;
  tone?: ToastTone;
  /** One quiet action ("Undo", "Retry"). */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it hides. Defaults: 4000, errors and toasts with an action 8000. */
  durationMs?: number;
}

export interface ToastApi {
  show: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 3;

/** Use inside a ToastProvider: `const toast = useToast(); toast.show({ message: 'Camera saved.' })`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}

const TONE_ICON = { info: 'info', success: 'check', error: 'warning' } as const;

/** Mount once around the app. Toasts show at the top on phones and bottom-left on laptops. */
export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const tone = options.tone ?? 'info';
      const duration = options.durationMs ?? (tone === 'error' || options.action ? 8000 : 4000);
      setItems((list) => [...list, { ...options, tone, id }].slice(-MAX_VISIBLE));
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), duration),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div class="toast-region" aria-live="polite" aria-relevant="additions">
        {items.map((item) => {
          const tone = item.tone ?? 'info';
          return (
            <div key={item.id} class={cx('toast', `toast-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
              <Icon name={TONE_ICON[tone]} size={20} />
              <p class="toast-message">{item.message}</p>
              {item.action && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    item.action?.onClick();
                    dismiss(item.id);
                  }}
                >
                  {item.action.label}
                </Button>
              )}
              <IconButton icon="close" label="Dismiss" size="s" onClick={() => dismiss(item.id)} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
