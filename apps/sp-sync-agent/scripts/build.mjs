/**
 * Bundles the agent to standalone CommonJS files.
 *
 * Two outputs, because the agent has two runtimes:
 *  - `dist/main.js`         plain Node (servers, CI, `node main.js`)
 *  - `dist/electron/main.js` the Electron desktop shell
 *
 * Why a bundle rather than `tsc` output: the agent imports Super Productivity's
 * own sources from `../../../src/app/**` and the workspace packages through the
 * `@sp/*` aliases. A `tsc` build either refuses to emit those (they sit outside
 * `rootDir`) or copies the entire Angular app tree into `dist/`. esbuild inlines
 * exactly the reachable graph and produces files that run with no
 * `node_modules` and no repo checkout.
 *
 * `electron` stays external in both: the desktop shell gets it from the runtime,
 * and keeping it external is what lets the plain-Node build run without Electron
 * installed at all.
 *
 * Usage: node scripts/build.mjs [--minify] [--sourcemap] [--outfile <path>]
 */
import { build } from 'esbuild';
import { builtinModules as builtinModuleNames, createRequire } from 'node:module';
import { rmSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAliases } from './aliases.mjs';

const requireResolve = createRequire(import.meta.url).resolve;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { aliases: ALIASES } = loadAliases();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const outfile = resolve(appDir, value('--outfile', 'dist/main.js'));
const minify = flag('--minify');
const sourcemap = flag('--sourcemap') ? 'external' : false;
const electronOutfile = resolve(appDir, 'dist/electron/main.js');

const builtinModules = new Set([
  ...builtinModuleNames,
  ...builtinModuleNames.map((name) => `node:${name}`),
]);

/**
 * Resolves the workspace aliases and biases bare specifiers to the agent's own
 * `node_modules`.
 *
 * The bias matters: an `import '@ngrx/store'` from inside `src/app/**` would
 * otherwise walk up to the repo root, whose install is not guaranteed complete
 * (this workspace has empty package directories), and esbuild has no way to
 * express "prefer this directory" for a plugin callback.
 */
const aliasPlugin = {
  name: 'sp-workspace-aliases',
  setup(pluginBuild) {
    const prefixes = Object.keys(ALIASES);
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      for (const alias of prefixes) {
        if (args.path === alias || args.path.startsWith(`${alias}/`)) {
          const rest = args.path.slice(alias.length).replace(/^\//, '');
          const mapped = ALIASES[alias];
          return { path: rest ? resolve(dirname(mapped), rest) : mapped };
        }
      }
      if (args.path.startsWith('.') || isAbsolute(args.path)) {
        return null;
      }
      if (builtinModules.has(args.path)) {
        return { path: args.path, external: true };
      }
      try {
        return { path: requireResolve(args.path, { paths: [appDir] }) };
      } catch {
        return null;
      }
    });
  },
};

rmSync(resolve(appDir, 'dist'), { recursive: true, force: true });
mkdirSync(dirname(electronOutfile), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify,
  sourcemap,
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  plugins: [aliasPlugin],
  logLevel: 'warning',
  metafile: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

const targets = [
  { label: 'node', entryPoints: [resolve(appDir, 'src/entry.ts')], outfile },
  {
    label: 'electron',
    entryPoints: [resolve(appDir, 'src/electron/main.ts')],
    outfile: electronOutfile,
  },
];

for (const { label, ...options } of targets) {
  const result = await build({ ...shared, ...options });
  const { size } = statSync(options.outfile);
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(
    `[build:${label}] ${options.outfile}\n` +
      `[build:${label}] ${inputs} modules, ${(size / 1024).toFixed(0)} KiB` +
      `${minify ? ' (minified)' : ''}${sourcemap ? ' + sourcemap' : ''}`,
  );
}

// The tray loads the icon from disk next to the bundle at runtime.
copyFileSync(resolve(appDir, 'build/icon.png'), resolve(appDir, 'dist/icon.png'));
