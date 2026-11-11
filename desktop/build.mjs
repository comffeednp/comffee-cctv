/**
 * Builds the desktop app into desktop/dist:
 *
 *   dist/main.cjs      main process (esbuild), with deploy/cloud-init.yaml.template baked in
 *   dist/preload.cjs   preload of the local screens (esbuild)
 *   dist/renderer/     local screens (Vite, desktop/vite.config.ts)
 *
 *   node desktop/build.mjs
 *
 * The installer is made afterwards by electron-builder (npm run build:desktop does both).
 */

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, '..');
const dist = join(root, 'dist');
const templatePath = join(repo, 'deploy', 'cloud-init.yaml.template');

if (!existsSync(templatePath)) {
  console.error('deploy/cloud-init.yaml.template is missing. The app needs it to set up new servers.');
  process.exit(1);
}
const template = readFileSync(templatePath, 'utf8');
if (!template.includes('{{SETUP_CODE}}')) {
  console.error('deploy/cloud-init.yaml.template has no {{SETUP_CODE}} placeholder.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [join(root, 'src', 'main', 'main.ts')],
  outfile: join(dist, 'main.cjs'),
  define: { __CLOUD_INIT_TEMPLATE__: JSON.stringify(template) },
});

await build({
  ...common,
  entryPoints: [join(root, 'src', 'preload', 'preload.ts')],
  outfile: join(dist, 'preload.cjs'),
});

await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'info' });
