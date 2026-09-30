/**
 * Loads the built Electron bundle and fails if it throws while being required.
 *
 * Why this exists: every other gate in the pipeline passed while the packaged
 * app was incapable of starting. Both causes were fatal at REQUIRE time —
 * above `app.whenReady()` and outside the try/catch inside it — so the process
 * died with no window, no tray, no error dialog and no data directory. A build
 * that packages cleanly and an app that launches are different claims, and
 * electron-builder only ever proves the first.
 *
 * It stubs `electron` so the bundle can be loaded by plain Node: the real
 * module throws outside an Electron runtime. `app.whenReady()` resolves to a
 * promise that never settles, so this asserts about module evaluation and
 * nothing else — it does not start the agent.
 *
 * Usage: node scripts/check-bundle-loads.mjs [path/to/main.js]
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(appDir, process.argv[2] ?? 'dist/electron/main.js');

if (!existsSync(bundle)) {
  console.error(`✗ bundle not found: ${bundle}`);
  console.error('  Run `npm run build` (or build:min) first.');
  process.exit(1);
}

const noop = () => {};
const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: noop,
    // Never settles: we are checking module evaluation, not booting the agent.
    whenReady: () => new Promise(noop),
    quit: noop,
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({}) },
  Tray: class {},
  clipboard: {},
  dialog: { showErrorBox: noop },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createEmpty: () => ({}),
  },
  shell: {},
};

const require_ = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return electronStub;
  }
  // electron's own index.js probes for its downloaded binary when the real
  // package is resolved from a plain-Node process.
  if (request.endsWith('electron/install.js')) {
    return {};
  }
  return originalLoad.call(this, request, ...rest);
};

try {
  require_(bundle);
} catch (error) {
  console.error(`✗ ${bundle} threw while being loaded:\n`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  console.error(
    '\nThis is the class of failure a packaged build hides: it happens during ' +
      'module evaluation, before any window, dialog or log exists.',
  );
  process.exit(1);
} finally {
  Module._load = originalLoad;
}

console.log(`✓ ${bundle} loads without throwing`);
