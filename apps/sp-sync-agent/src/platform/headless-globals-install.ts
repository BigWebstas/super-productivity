/**
 * Side-effect module: installs the headless browser globals at import time.
 *
 * This exists purely for import ORDER, and the ordering is load-bearing.
 *
 * Several app modules read browser globals while they are being *evaluated*,
 * not when they are used — `app.constants.ts` runs
 * `!!window.SUPAndroid` at module scope. So the globals must exist before those
 * modules are evaluated.
 *
 * A plain statement in the entry file is not enough: ES module semantics hoist
 * every import above every statement, so `installHeadlessGlobals()` written
 * between two imports still runs *after* both of them. Putting the call at the
 * top level of its own module and importing that module first makes the ordering
 * explicit and survives bundling, which lowers the entry to a sequence of
 * `require()` calls in source order.
 *
 * It also keeps the dev runner honest: `run-ts.mjs` installs the same globals
 * before loading the entry, and this makes the bundle behave the same way
 * without the runner.
 */
import { installHeadlessGlobals } from './headless-globals';

installHeadlessGlobals();
