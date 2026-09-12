// Builds the VS Code extension: bundles the extension host code and the difit
// server (from the monorepo source) with esbuild, then copies the prebuilt
// client assets and the @parcel/watcher native prebuilds into dist/.
import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { load as loadYaml } from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distDir = path.join(here, 'dist');
const require = createRequire(import.meta.url);
/** @typedef {{ packages?: Record<string, { resolution?: { integrity?: unknown } }> }} Lockfile */
/** @type {Lockfile} */
const lockfile = /** @type {Lockfile} */ (
  loadYaml(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')) ?? {}
);

// Native prebuilds shipped in the VSIX. Covers every platform VS Code desktop
// runs on; a missing prebuild only disables live reload there (difit loads the
// watcher lazily), so unavailable targets are skipped with a warning.
const WATCHER_PREBUILD_PACKAGES = [
  '@parcel/watcher-darwin-arm64',
  '@parcel/watcher-darwin-x64',
  '@parcel/watcher-win32-x64',
  '@parcel/watcher-win32-arm64',
  '@parcel/watcher-linux-x64-glibc',
  '@parcel/watcher-linux-x64-musl',
  '@parcel/watcher-linux-arm64-glibc',
  '@parcel/watcher-linux-arm64-musl',
  '@parcel/watcher-linux-arm-glibc',
  '@parcel/watcher-linux-arm-musl',
];

rmSync(distDir, { recursive: true, force: true });

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
};

// 1. Extension host bundle.
await build({
  ...commonOptions,
  entryPoints: [path.join(here, 'src/extension.ts')],
  outfile: path.join(distDir, 'extension.js'),
  external: ['vscode'],
});

// 2. difit server bundle, built straight from the monorepo source.
const watcherPackageJson = require.resolve('@parcel/watcher/package.json');
await build({
  ...commonOptions,
  entryPoints: [path.join(here, 'src/server-entry.ts')],
  outfile: path.join(distDir, 'server/index.js'),
  alias: {
    '@': path.join(repoRoot, 'src'),
    // Load the native binding from dist/server/prebuilds instead of node_modules.
    '@parcel/watcher': path.join(here, 'src/watcher-shim.ts'),
    '#parcel-watcher-wrapper': path.join(path.dirname(watcherPackageJson), 'wrapper.js'),
    // The server never opens a browser from inside the extension.
    open: path.join(here, 'src/open-stub.ts'),
  },
  // server.ts derives __dirname from import.meta.url; emulate it in CJS.
  define: { 'import.meta.url': '__difitImportMetaUrl' },
  banner: {
    js: "const __difitImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});

// 3. Prebuilt difit client (built by `pnpm --dir ../.. run build`).
const clientSource = path.join(repoRoot, 'dist', 'client');
if (!existsSync(path.join(clientSource, 'index.html'))) {
  console.error('error: dist/client is missing. Run `pnpm --dir ../.. run build` first.');
  process.exit(1);
}
cpSync(clientSource, path.join(distDir, 'client'), { recursive: true });

// 4. @parcel/watcher native prebuilds for all supported platforms.
const watcherVersion = /** @type {{ version: string }} */ (require(watcherPackageJson)).version;
const cacheDir = path.join(here, '.cache', `watcher-prebuilds-${watcherVersion}`);
const requireFromWatcher = createRequire(watcherPackageJson);

let copied = 0;
for (const packageName of WATCHER_PREBUILD_PACKAGES) {
  const binary =
    resolveLocalPrebuild(packageName) ?? (await fetchPrebuild(packageName, watcherVersion));
  if (!binary) {
    console.warn(`warn: skipping ${packageName} (not installed and download failed)`);
    continue;
  }

  const destination = path.join(distDir, 'server', 'prebuilds', packageName, 'watcher.node');
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(binary, destination);
  copied += 1;
}
console.log(`watcher prebuilds: ${copied}/${WATCHER_PREBUILD_PACKAGES.length} bundled`);

/**
 * @param {string} packageName
 * @returns {string | undefined}
 */
function resolveLocalPrebuild(packageName) {
  try {
    return requireFromWatcher.resolve(packageName);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} packageName
 * @param {string} version
 * @returns {Promise<string | undefined>}
 */
async function fetchPrebuild(packageName, version) {
  const extractDir = path.join(cacheDir, packageName);
  const cachedBinary = path.join(extractDir, 'package', 'watcher.node');
  const integrity = getLockedIntegrity(packageName, version);
  const integrityMarker = path.join(extractDir, '.integrity');
  if (
    existsSync(cachedBinary) &&
    existsSync(integrityMarker) &&
    readFileSync(integrityMarker, 'utf8').trim() === integrity
  ) {
    return cachedBinary;
  }

  const tarballBaseName = packageName.split('/')[1];
  const url = `https://registry.npmjs.org/${packageName}/-/${tarballBaseName}-${version}.tgz`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const tarball = Buffer.from(await response.arrayBuffer());
    verifyIntegrity(tarball, integrity, packageName, version);

    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    const tarballPath = path.join(extractDir, 'package.tgz');
    writeFileSync(tarballPath, tarball);

    const result = spawnSync('tar', [
      '-xzf',
      tarballPath,
      '-C',
      extractDir,
      'package/watcher.node',
    ]);
    rmSync(tarballPath, { force: true });
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString().trim() || 'tar extraction failed');
    }
    writeFileSync(integrityMarker, `${integrity}\n`, { mode: 0o600 });

    return cachedBinary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warn: failed to download ${packageName}@${version}: ${message}`);
    return undefined;
  }
}

/**
 * @param {string} packageName
 * @param {string} version
 * @returns {string}
 */
function getLockedIntegrity(packageName, version) {
  const entry = lockfile?.packages?.[`${packageName}@${version}`];
  const integrity = entry?.resolution?.integrity;
  if (typeof integrity !== 'string' || !/^sha(256|384|512)-/.test(integrity)) {
    throw new Error(`Missing lockfile integrity for ${packageName}@${version}`);
  }
  return integrity;
}

/**
 * @param {Buffer} content
 * @param {string} integrity
 * @param {string} packageName
 * @param {string} version
 */
function verifyIntegrity(content, integrity, packageName, version) {
  const [algorithm, encodedDigest] = integrity.split('-', 2);
  const expected = Buffer.from(encodedDigest, 'base64');
  const actual = createHash(algorithm).update(content).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`Integrity verification failed for ${packageName}@${version}`);
  }
}
