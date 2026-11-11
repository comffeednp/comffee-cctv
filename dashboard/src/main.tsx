import { render } from 'preact';
import './styles/theme.css';
import './app/app.css';
import { NavigationContext, ToastProvider, registerServiceWorker } from './components/index.ts';
import { App } from './app/App.tsx';
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

registerServiceWorker();
