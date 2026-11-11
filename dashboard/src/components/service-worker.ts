/**
 * Registers /sw.js (it caches the app shell only, never /api, /live or recordings). Call once from
 * main.tsx. Skipped in development so Vite's live reload is never cached.
 */
export function registerServiceWorker(): void {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  if (!('serviceWorker' in navigator) || env?.DEV) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
