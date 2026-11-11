/**
 * Builds the bridge program.
 *
 *   node bridge/build.mjs                 bundle + single executable for this computer's platform
 *   node bridge/build.mjs --bundle-only   only the bundled script (bridge/dist/comffee-cctv-bridge.cjs)
 *
 * The single executable is this Node binary with the bundled script injected (Node SEA + postject).
 * Build on Windows for bridge/dist/comffee-cctv-bridge.exe (install-windows.ps1 finds it there or next
 * to itself) and on Linux (x64 or arm64) for bridge/dist/comffee-cctv-bridge-linux-<arch>.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postject from 'postject';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const bundle = join(dist, 'comffee-cctv-bridge.cjs');
const bundleOnly = process.argv.includes('--bundle-only');

mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'info',
});

if (bundleOnly) process.exit(0);

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const blob = join(dist, 'sea-prep.blob');
const seaConfig = join(dist, 'sea-config.json');
// Windows: plain comffee-cctv-bridge.exe, the name install-windows.ps1 looks for. Others keep the
// platform in the name so Linux x64 and arm64 builds can sit side by side.
const exe = join(dist, isWindows ? 'comffee-cctv-bridge.exe' : `comffee-cctv-bridge-${process.platform}-${process.arch}`);

writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
if (isMac) execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });

await postject.inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
});

if (isMac) execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
if (!isWindows) chmodSync(exe, 0o755);
rmSync(blob, { force: true });
rmSync(seaConfig, { force: true });

console.log(`Bridge program written to ${exe}`);
if (isWindows) {
  console.log('Note: the copied Node signature no longer matches; sign the .exe with your own certificate if you publish it.');
}
