import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const hub = 'http://127.0.0.1:8080';
// The hub refuses /api writes whose Origin is not its publicOrigin (http://localhost:8080 in development).
// The dev server runs on another port, so the proxy speaks for the hub's own origin. Set CCTV_DEV_ORIGIN when
// the development hub uses another publicOrigin.
const hubOrigin = process.env.CCTV_DEV_ORIGIN || 'http://localhost:8080';
// In production Caddy sends /live/<path>/whep to MediaMTX WebRTC with the /live prefix stripped; do the same here.
const mediamtxWebrtc = 'http://127.0.0.1:8889';

export default defineConfig({
  root,
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: hub,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Only replace an Origin the browser sent; requests without one stay without one.
            if (proxyReq.getHeader('origin') !== undefined) proxyReq.setHeader('origin', hubOrigin);
          });
        },
      },
      '/live': { target: mediamtxWebrtc, changeOrigin: false, rewrite: (path) => path.replace(/^\/live/, '') },
      '/bridge': { target: hub, ws: true, changeOrigin: false },
    },
  },
});
