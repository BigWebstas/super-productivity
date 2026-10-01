/**
 * Browser-global shims for running Super Productivity's DI-free domain code in
 * a Node/Electron main process.
 *
 * The reducers, meta-reducers, action creators and op-log core that this agent
 * reuses are pure functions, but a handful of transitively imported modules
 * read browser globals at MODULE LOAD time (e.g. `app.constants.ts` evaluates
 * `window.SUPAndroid`, the SuperSync storage port uses `localStorage`). Without
 * these shims the import graph throws `ReferenceError: window is not defined`
 * before any of our code runs.
 *
 * Everything installed here is inert and deterministic. Deliberately NOT
 * emulated: `window.innerWidth`, `matchMedia`, `requestAnimationFrame`,
 * `indexedDB`, service workers. A module needing one of those is a signal that
 * it belongs to the UI, not the domain, and must not be pulled in here.
 */

interface MutableGlobal {
  [key: string]: unknown;
}

const g = globalThis as unknown as MutableGlobal;

const isAlreadyDefined = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(g, key) && g[key] !== undefined;

/**
 * In-memory `localStorage`. The SuperSync provider persists its server cursor
 * here; the agent backs that with a file instead, but the port contract is
 * satisfied by this shim so the package stays unchanged.
 */
const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(String(key), String(value));
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    clear: (): void => {
      map.clear();
    },
  } as Storage;
};

/**
 * Installs the shims. Idempotent, and never overwrites a real implementation
 * (so the same code is safe if it is ever loaded next to a DOM).
 */
export const installHeadlessGlobals = (): void => {
  if (!isAlreadyDefined('window')) {
    // `window === globalThis` is what Angular's and the app's platform checks
    // expect: `!!window` becomes true, and `window.SUPAndroid` / `window.isElectron`
    // stay undefined → the non-native, non-Capacitor branches are taken.
    g['window'] = globalThis;
  }
  if (!isAlreadyDefined('localStorage')) {
    g['localStorage'] = createMemoryStorage();
  }
  if (!isAlreadyDefined('navigator')) {
    g['navigator'] = { userAgent: 'sp-bridge', language: 'en-US' };
  }
  if (!isAlreadyDefined('document')) {
    // Minimal stub so a BOXED reducer error degrades to a log instead of a
    // crash: `reducerFailureGuardMetaReducer` keeps state alive by design
    // (#10195), but its dev-mode reporter (`devError` → `alert`/`confirm`)
    // touches `document` and would otherwise kill this process from a
    // setTimeout after the guard already recovered. Only the error-dialog
    // surface is stubbed — never layout, events, or rendering.
    g['document'] = { activeElement: null };
  }
  const w = g['window'] as Record<string, unknown>;
  if (w['alert'] === undefined) {
    w['alert'] = (message: unknown): void => {
      console.warn(`[headless alert] ${String(message)}`);
    };
  }
  if (w['confirm'] === undefined) {
    // Headless "don't throw": devError's "Throw an error?" prompt must answer
    // no outside a developer's browser, or every boxed reducer error is fatal.
    w['confirm'] = (): boolean => false;
  }
};
