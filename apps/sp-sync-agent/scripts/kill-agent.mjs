#!/usr/bin/env node
/**
 * Kills a runaway SP Sync Agent, including every process it spawned.
 *
 * Why a tree kill and not a single PID: the agent is an Electron app, so the
 * window you see in Task Manager is a launcher that owns child renderer, GPU
 * and utility processes. Killing the parent alone orphans those, they keep
 * their memory, and the tray icon disappears while the RAM does not come back.
 * `taskkill /T` and the POSIX descendant walk both handle that.
 *
 * Node rather than a shell script because the agent is a Node project and this
 * has to run identically on the Windows machine it is meant to debug and on
 * Linux/macOS during development.
 *
 * Usage:
 *   node scripts/kill-agent.mjs              # list what matched, then kill it
 *   node scripts/kill-agent.mjs --dry-run    # list only, kill nothing
 *   node scripts/kill-agent.mjs --pattern foo
 */
import { execFileSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const dryRun = hasFlag('--dry-run');
/**
 * Deliberately narrow: only the agent's own names.
 *
 * An earlier default also matched a bare `electron`, which is a footgun — on
 * Linux that is the binary name for *any* Electron dev process, so it would
 * have killed an unrelated project's dev server, and on Windows several
 * shipping apps (Slack, Discord, VS Code's helper processes) are Electron
 * based. Matching them by accident and force-killing them is not a recoverable
 * mistake, and a broad default is not worth the convenience.
 *
 * The agent's own dev runs need an explicit pattern, because `npm start` here
 * executes plain Node and so is indistinguishable from any other node process:
 *   npm run kill -- --pattern 'dist/main.js'
 */
const pattern = flagValue('--pattern', 'SP Sync Agent|sp-sync-agent');
const isWindows = process.platform === 'win32';

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** @returns {{pid:number, ppid:number, rssKb:number, name:string}[]} */
const listProcesses = () => {
  if (isWindows) {
    // WMIC is deprecated and gone from current Windows, so PowerShell's CIM is
    // the way to get ppid + working set in one shot. `powershell.exe` is
    // Windows PowerShell 5.1 and ships on every supported Windows; `pwsh` is
    // PowerShell 7 and often absent. Both are tried because an execution-policy
    // or enterprise lockdown can block one but not the other.
    const script =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress';

    let out;
    const tried = [];
    for (const shell of ['powershell.exe', 'pwsh']) {
      try {
        out = run(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
        break;
      } catch (error) {
        tried.push(`${shell} (${error.code ?? error.message})`);
      }
    }
    if (out === undefined) {
      throw new Error(
        `could not query processes via PowerShell — tried ${tried.join(', ')}. ` +
          'Run this from a normal (non-elevated is fine) PowerShell or cmd prompt.',
      );
    }

    // A single process serialises as an object, several as an array.
    const parsed = JSON.parse(out.trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((p) => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId),
      rssKb: Math.round(Number(p.WorkingSetSize) / 1024),
      name: String(p.Name ?? ''),
    }));
  }

  // `rss` is in KiB on Linux/macOS ps.
  const out = run('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, rss, ...rest] = line.split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssKb: Number(rss),
        name: rest.join(' '),
      };
    })
    .filter((p) => Number.isFinite(p.pid));
};

const mb = (kb) => `${(kb / 1024).toFixed(0)} MB`;

/** Every descendant of `roots`, deepest first, so children die before parents. */
const withDescendants = (all, roots) => {
  const byParent = new Map();
  for (const p of all) {
    if (!byParent.has(p.ppid)) {
      byParent.set(p.ppid, []);
    }
    byParent.get(p.ppid).push(p);
  }
  const out = [];
  const walk = (p) => {
    for (const child of byParent.get(p.pid) ?? []) {
      walk(child);
      out.push(child);
    }
  };
  roots.forEach(walk);
  return out;
};

const self = process.pid;
let all;
try {
  all = listProcesses();
} catch (error) {
  console.error(`✗ Could not list processes: ${error.message}`);
  process.exit(1);
}

const re = new RegExp(pattern, 'i');
const matches = all.filter((p) => re.test(p.name) && p.pid !== self);

if (!matches.length) {
  console.log(`✓ No process matching /${pattern}/ is running.`);
  process.exit(0);
}

const roots = matches.filter((p) => !matches.some((other) => other.pid === p.ppid));
const children = withDescendants(all, roots);
const targets = [...new Map([...roots, ...children].map((p) => [p.pid, p])).values()];
const totalKb = targets.reduce((sum, p) => sum + p.rssKb, 0);

console.log(`Found ${targets.length} process(es), ${mb(totalKb)} resident:\n`);
for (const p of targets.sort((a, b) => b.rssKb - a.rssKb)) {
  const kind = roots.some((r) => r.pid === p.pid) ? 'root ' : 'child';
  console.log(
    `  ${kind}  ${String(p.pid).padStart(7)}  ${mb(p.rssKb).padStart(9)}  ${p.name}`,
  );
}

if (dryRun) {
  console.log('\n--dry-run: nothing killed.');
  process.exit(0);
}

// Windows gets taskkill /T, which handles the tree atomically. On POSIX the
// descendants were already resolved above, and children are killed first
// because killing a parent re-parents its children and loses the handle.
if (isWindows) {
  for (const p of targets.sort((a, b) => a.pid - b.pid)) {
    const res = spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    if (res.status !== 0) {
      console.warn(`  ! could not kill ${p.pid} (${p.name})`);
    }
  }
} else {
  for (const p of targets.reverse()) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.warn(`  ! could not kill ${p.pid} (${p.name}): ${error.code}`);
      }
    }
  }
}

console.log(`\n✓ Killed ${targets.length} process(es), freeing ~${mb(totalKb)}.`);
