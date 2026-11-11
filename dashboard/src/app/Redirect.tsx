import { useEffect } from 'preact/hooks';
import { Spinner } from '../components/index.ts';
import { navigate } from '../lib/router.ts';

/** Full-screen spinner for the first load and for redirects. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <main class="app-main">
      <div class="app-loading">
        <Spinner size={32} label={label} />
      </div>
    </main>
  );
}

/** Spinner in the page's place, for loading inside the signed-in frame. */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div class="app-loading">
      <Spinner size={32} label={label} />
    </div>
  );
}

/** Moves to another in-app path once rendered (never during render). Never leaves this origin. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true, sameOriginOnly: true });
  }, [to]);
  return <Loading />;
}
