/**
 * Bundles the agent to a single standalone CommonJS file.
 *
 * Why a bundle rather than `tsc` output: the agent imports Super Productivity's
 * own sources from `../../../src/app/**` and the workspace packages via the
 * `@sp/*` aliases. A `tsc` build would either refuse to emit them (they sit
 * outside `rootDir`) or copy the entire Angular app tree into `dist/`. The
 * bundle inlines exactly the reachable graph and produces one file that runs on
 * a bare Node install with no `node_modules` and no repo checkout.
 *
 * Node builtins and `electron` stay external. `electron` is required lazily by
 * the future tray/packaging layer; marking it external keeps this build usable
 * under plain `node` today instead of failing at startup on a missing module.
 *
 * Usage: node scripts/build.mjs [--minify] [--sourcemap] [--outfile <path>]
 */
import { build } from 'esbuild';
import { builtinModules as builtinModuleNames, createRequire } from 'node:module';
import { rmSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireResolve = createRequire(import.meta.url).resolve;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appDir, '../..');

/** Mirrors the path aliases in tsconfig.json / scripts/run-ts.mjs. */
const ALIASES = {
  '@super-productivity/plugin-api': 'packages/plugin-api/src/index.ts',
  '@sp/shared-schema': 'packages/shared-schema/src/index.ts',
  '@sp/sync-core': 'packages/sync-core/src/index.ts',
  '@sp/sync-providers/super-sync': 'packages/sync-providers/src/super-sync.ts',
  '@sp/sync-providers/http': 'packages/sync-providers/src/http.ts',
  '@sp/sync-providers/errors': 'packages/sync-providers/src/errors.ts',
  '@sp/sync-providers/credential-store':
    'packages/sync-providers/src/credential-store.ts',
  '@sp/sync-providers/platform': 'packages/sync-providers/src/platform.ts',
  '@sp/sync-providers/log': 'packages/sync-providers/src/log.ts',
  '@sp/sync-providers/provider-types': 'packages/sync-providers/src/provider-types.ts',
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const outfile = resolve(appDir, value('--outfile', 'dist/main.js'));
const minify = flag('--minify');
const sourcemap = flag('--sourcemap') ? 'external' : false;

/**
 * Rewrites the workspace aliases to absolute paths.
 *
 * esbuild resolves from the importing file, and the app's own sources sit
 * outside the agent, so the aliases have to be absolute to be found at all.
 *
 * Bare specifiers are resolved here too, biased to the agent's own
 * `node_modules`. Two reasons: an `import '@ngrx/store'` from inside
 * `src/app/**` would otherwise walk up to the repo root, whose install in this
 * workspace is partially broken (empty package directories); and returning
 * `null` lets esbuild apply its own algorithm, which has no such bias.
 */
const builtinModules = new Set([
  ...builtinModuleNames,
  ...builtinModuleNames.map((name) => `node:${name}`),
]);

const aliasPlugin = {
  name: 'sp-workspace-aliases',
  setup(pluginBuild) {
    const prefixes = Object.keys(ALIASES);
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      for (const alias of prefixes) {
        if (args.path === alias || args.path.startsWith(`${alias}/`)) {
          const rest = args.path.slice(alias.length).replace(/^\//, '');
          const mapped = resolve(repoRoot, ALIASES[alias]);
          return { path: rest ? resolve(dirname(mapped), rest) : mapped };
        }
      }

      if (args.path.startsWith('.') || isAbsolute(args.path)) {
        return null; // relative/absolute: esbuild's own handling is correct
      }
      if (builtinModules.has(args.path)) {
        return { path: args.path, external: true };
      }
      try {
        return { path: requireResolve(args.path, { paths: [appDir] }) };
      } catch {
        // Not resolvable from the agent (e.g. a dependency only present in the
        // repo root). Let esbuild try its normal resolution and report it.
        return null;
      }
    });
  },
};

rmSync(dirname(outfile), { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(appDir, 'src/entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify,
  sourcemap,
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  plugins: [aliasPlugin],
  logLevel: 'info',
  metafile: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});

const { size } = statSync(outfile);
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `[build] ${outfile}\n` +
    `[build] ${inputs} modules bundled, ${(size / 1024).toFixed(0)} KiB` +
    `${minify ? ' (minified)' : ''}${sourcemap ? ' + sourcemap' : ''}`,
);
