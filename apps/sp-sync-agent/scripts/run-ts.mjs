/**
 * Minimal, dependency-free TypeScript runner for the agent.
 *
 * Why this exists: this workspace's node_modules is incomplete — `@vitest/*`
 * are empty directories, `@esbuild/linux-x64` is absent, and ts-node cannot
 * load because `@jridgewell/sourcemap-codec` is missing. Rather than run
 * `npm install` (which would touch the whole Angular workspace), this hooks
 * `require.extensions` and transpiles with the TypeScript compiler API, which
 * IS installed.
 *
 * It also resolves the workspace path aliases (`@sp/*`,
 * `@super-productivity/plugin-api`) by patching module resolution, so agent
 * code can import the real Super Productivity sources directly.
 *
 * Usage: node scripts/run-ts.mjs <entry-relative-to-app-dir> [args...]
 */
import { createRequire } from 'node:module';
import Module, { isBuiltin } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAliases } from './aliases.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appDir, '../..');
/**
 * Workspace path aliases, read from tsconfig.json so this runner, the esbuild
 * bundler and the type-checker can never disagree about them. They were three
 * hand-maintained copies that drifted within one commit of each other.
 */
const { aliases: ALIASES } = loadAliases();

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useDefineForClassFields: false,
  inlineSourceMap: true,
  inlineSources: true,
  skipLibCheck: true,
};

// ── require hook: transpile .ts on the fly ────────────────────────────────────
const compileTs = (module_, filename) => {
  const source = readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: filename,
  });
  module_._compile(outputText, filename);
};

require.extensions['.ts'] = compileTs;
require.extensions['.tsx'] = compileTs;

// ── module resolution hook: workspace aliases ──────────────────────────────────
const ALIAS_PREFIXES = Object.keys(ALIASES);
const originalResolve = Module._resolveFilename;
/** See the re-entrancy note at the agent-dir resolution branch below. */
let resolvingFromAgentDir = false;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (!parent?.filename?.startsWith(repoRoot)) {
    return originalResolve.call(this, request, parent, isMain, options);
  }

  for (const alias of ALIAS_PREFIXES) {
    if (request === alias || request.startsWith(`${alias}/`)) {
      const rest = request.slice(alias.length).replace(/^\//, '');
      const mapped = resolve(repoRoot, ALIASES[alias]);
      return rest ? resolve(dirname(mapped), rest) : mapped;
    }
  }

  // Resolve from the agent's own directory FIRST. This repo's root node_modules
  // is not merely incomplete but actively broken: some packages are empty
  // directories, and at least one (@ngrx/store) was left half-populated by an
  // aborted install, so it resolves and then fails on a missing peer. Node's
  // normal walk-up reaches the root tree before the agent's, so without this the
  // broken copy shadows the working one. `paths: [appDir]` also walks upward, so
  // a dependency only present in the root (typia, @super-productivity/*) still
  // resolves — the agent's copy simply wins where both exist.
  if (!request.startsWith('.') && !request.startsWith('/') && !isBuiltin(request)) {
    // Re-entrancy guard: `require.resolve(request, { paths })` synthesises a
    // fake parent located under appDir, which is inside repoRoot — so the guard
    // above lets it back into this hook, which would call itself forever.
    if (!resolvingFromAgentDir) {
      resolvingFromAgentDir = true;
      try {
        return require.resolve(request, { paths: [appDir] });
      } catch {
        // Fall through to normal resolution for anything the agent's tree lacks.
      } finally {
        resolvingFromAgentDir = false;
      }
    }
  }

  return originalResolve.call(this, request, parent, isMain, options);
};

// ── run ───────────────────────────────────────────────────────────────────────
const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <entry> [args...]');
  process.exit(2);
}

const entryPath = resolve(appDir, entry);

// Present the entry as the running script, the way `node src/main.ts` would.
// Without this, `process.argv[1]` stays this runner and any
// "am I the entry point?" check inside the app silently never fires.
// The entry itself is dropped from the args so the entry sees
// [node, entry, ...entryArgs], not [node, entry, entry, ...entryArgs].
process.argv = [process.argv[0], entryPath, ...rest];
try {
  // `@ngrx/store` (and anything else partially compiled for Angular) declares
  // its injectables via ɵɵngDeclareFactory, which falls back to the JIT
  // compiler. Nothing AOT-links these node-side bundles, so the compiler has to
  // be present BEFORE the first @ngrx/@angular import is evaluated. Reducers and
  // meta-reducers never need DI itself — this only satisfies module init.
  await import('@angular/compiler');
} catch {
  console.warn(
    'run-ts: @angular/compiler not loadable; Angular-decorated modules may fail',
  );
}

// Browser globals some transitively imported app modules read at load time.
require(resolve(appDir, 'src/platform/headless-globals.ts')).installHeadlessGlobals();
require(resolve(appDir, 'src/platform/agent-logging.ts')).configureAgentLogging(
  process.env.SP_AGENT_LOG_LEVEL === 'info' ? 'info' : 'error',
);

try {
  require(entryPath);
} catch (error) {
  if (error?.code === 'ERR_REQUIRE_ESM') {
    // A dependency (typia, ngx) is ESM-only. Surfacing the real module name is
    // far more useful than the raw ERR_REQUIRE_ESM.
    console.error(
      `run-ts: "${entryPath}" pulled in an ESM-only dependency and cannot run under ` +
        `this CommonJS require hook. Bundle with tsc/esbuild instead, or stub the ` +
        `import. Cause: ${error.message.split('\n')[0]}`,
    );
    process.exit(1);
  }
  throw error;
}
