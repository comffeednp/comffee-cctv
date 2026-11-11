// Builds the desktop app's local screens (separate from the dashboard build). They reuse the dashboard's
// components and theme by relative import, and its public folder for the 72 fonts and the camera mark.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./renderer'),
  base: '/',
  publicDir: here('../dashboard/public'),
  plugins: [preact()],
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    fs: { allow: [here('..')] },
  },
});
