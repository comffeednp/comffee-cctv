#!/usr/bin/env node
/**
 * Development helper: downloads the MediaMTX release pinned in deploy/mediamtx.yml.template into
 * .cache/mediamtx-<version>/, verifies it against that release's checksums file and unpacks it.
 *
 *   node scripts/dev/fetch-mediamtx.mjs          prints the path of the MediaMTX executable
 *
 * Runs on Windows (amd64), Linux (amd64, arm64) and macOS (amd64, arm64). Nothing is downloaded
 * again when the executable is already there.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(REPO_ROOT, 'deploy', 'mediamtx.yml.template');
const CACHE_DIR = path.join(REPO_ROOT, '.cache');
const RELEASES = 'https://github.com/bluenviron/mediamtx/releases/download';

/** The pinned version, from the template's first comment ("... MediaMTX v1.21.3 (pinned release)"). */
export function pinnedVersion(templateText = readFileSync(TEMPLATE, 'utf8')) {
  const m = /MediaMTX\s+(v\d+\.\d+\.\d+)/.exec(templateText);
  if (!m) throw new Error(`No pinned MediaMTX version found in ${TEMPLATE}`);
  return m[1];
}

function platformParts() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error(`No MediaMTX release for ${process.platform}/${process.arch}`);
  return { os, arch, ext: os === 'windows' ? 'zip' : 'tar.gz', exe: os === 'windows' ? 'mediamtx.exe' : 'mediamtx' };
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'comffee-cctv-dev-fetch' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Returns the absolute path of the MediaMTX executable, downloading and verifying it first if needed. */
export async function ensureMediamtx() {
  const version = pinnedVersion();
  const { os, arch, ext, exe } = platformParts();
  const targetDir = path.join(CACHE_DIR, `mediamtx-${version}-${os}-${arch}`);
  const exePath = path.join(targetDir, exe);
  if (existsSync(exePath)) return exePath;

  const archiveName = `mediamtx_${version}_${os}_${arch}.${ext}`;
  const sums = (await download(`${RELEASES}/${version}/checksums.sha256`)).toString('utf8');
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${archiveName}`) || l.trim().endsWith(`*${archiveName}`));
  if (!line) throw new Error(`${archiveName} is not listed in the ${version} checksums file`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Checksums file line is not a SHA-256 hash');

  const archive = await download(`${RELEASES}/${version}/${archiveName}`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`);

  // Unpack into a fresh folder of its own, then move it into place.
  mkdirSync(CACHE_DIR, { recursive: true });
  const work = `${targetDir}.partial`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archivePath = path.join(CACHE_DIR, archiveName);
  writeFileSync(archivePath, archive);
  try {
    // Windows: the bsdtar built into Windows 10 and later reads zip files (a GNU tar earlier on PATH,
    // for example from Git Bash, does not). Elsewhere the system tar reads the .tar.gz.
    const tar = os === 'windows' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', archivePath, '-C', work], { stdio: 'inherit' });
  } finally {
    rmSync(archivePath, { force: true });
  }
  if (!existsSync(path.join(work, exe))) throw new Error(`${exe} not found in ${archiveName}`);
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(work, targetDir);
  return exePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureMediamtx()
    .then((p) => process.stdout.write(`${p}\n`))
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
