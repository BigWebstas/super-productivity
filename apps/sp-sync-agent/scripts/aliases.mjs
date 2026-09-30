/**
 * Single source of truth for the agent's workspace path aliases.
 *
 * The alias map used to be duplicated in three places (tsconfig.json,
 * scripts/run-ts.mjs, scripts/build.mjs). They drifted immediately: the two
 * scripts listed a subset of the subpaths, and the type-check silently fell
 * back to the workspace symlinks in node_modules for the ones they missed —
 * producing errors in app sources that the agent itself resolves fine. Reading
 * it from tsconfig.json means adding an alias is a one-line change that all
 * three consumers pick up, or a build error if the file is malformed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Returns `{ aliases, baseUrl }` with absolute target paths.
 *
 * `baseUrl` comes from tsconfig's own `baseUrl` (declared relative to the
 * agent), resolved against the agent directory — not a hardcoded `../..`, which
 * is what would break if the tsconfig moved.
 */
export const loadAliases = () => {
  const tsconfigPath = resolve(appDir, 'tsconfig.json');
  const tsconfig = JSON.parse(
    // tsconfig permits comments; the agent's own has several explanatory ones.
    readFileSync(tsconfigPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  const options = tsconfig.compilerOptions ?? {};
  const baseUrl = resolve(appDir, options.baseUrl ?? '../..');
  const aliases = Object.fromEntries(
    Object.entries(options.paths ?? {}).map(([alias, [target]]) => [
      alias,
      resolve(baseUrl, target),
    ]),
  );
  return { aliases, baseUrl };
};
