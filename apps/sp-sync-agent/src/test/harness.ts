/**
 * Test runner: a minimal assertion harness.
 *
 * This workspace's vitest install is broken (`@vitest/*` are empty directories),
 * so the agent uses `node:assert` plus a tiny runner rather than pulling tests
 * into a dependency the repo does not otherwise have working.
 */
interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const suites: { name: string; cases: TestCase[] }[] = [];
let currentSuite: { name: string; cases: TestCase[] } | null = null;

export const describe = (name: string, fn: () => void): void => {
  currentSuite = { name, cases: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
};

export const it = (name: string, fn: () => void | Promise<void>): void => {
  if (!currentSuite) {
    throw new Error(`it("${name}") must be called inside describe()`);
  }
  currentSuite.cases.push({ name, fn });
};

export const runAll = async (): Promise<void> => {
  let passed = 0;
  const failures: string[] = [];

  // A test that forgets to return its promise detaches, and its assertion
  // failure then surfaces as an unhandled rejection that kills the process
  // AFTER the summary has printed — which reads as a green run that crashed.
  // Capturing it here turns that into a reported failure instead.
  const detachedFailures: string[] = [];
  const onUnhandled = (reason: unknown): void => {
    detachedFailures.push(
      `detached async failure (a test did not return its promise): ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
  };
  process.on('unhandledRejection', onUnhandled);

  for (const suite of suites) {
    console.log(`\n${suite.name}`);
    for (const testCase of suite.cases) {
      try {
        await testCase.fn();
        passed++;
        console.log(`  ✓ ${testCase.name}`);
      } catch (error) {
        failures.push(
          `${suite.name} › ${testCase.name}\n    ${(error as Error).message}`,
        );
        console.log(`  ✗ ${testCase.name}`);
      }
    }
  }

  // Give detached rejections a turn to surface before reporting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off('unhandledRejection', onUnhandled);
  failures.push(...detachedFailures);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) {
      console.log(`\n${failure}`);
    }
    process.exitCode = 1;
  }
};
