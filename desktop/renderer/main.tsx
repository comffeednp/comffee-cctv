import { render } from 'preact';
import '../../dashboard/src/styles/theme.css';
import '../../dashboard/src/app/app.css';
import './desktop.css';
import { NavigationContext, ToastProvider } from '../../dashboard/src/components/index.ts';
import { App } from './App.tsx';
import { cctv } from './lib/bridge.ts';
import { navigate } from './lib/router.ts';

const root = document.getElementById('app');
if (root) {
  render(
    <NavigationContext.Provider value={(href) => navigate(href)}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </NavigationContext.Provider>,
    root,
  );
}

// The server's dashboard is drawn above this page; hide it while a menu or dialog of this page is open.
let overlayOpen = false;
const checkOverlay = () => {
  const open = document.querySelector('.k-popover, dialog[open]') !== null;
  if (open === overlayOpen) return;
  overlayOpen = open;
  void cctv.setOverlay(open);
};
new MutationObserver(checkOverlay).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
