// PreToolUse hook (Bash, PowerShell): one test run at a time on this machine, no test run cut
// short by `timeout`, and the whole E2E suite stays in CI. A refusal goes back to Claude (exit code
// 2) with what to do instead (docs/testing.md). Commands that run no tests pass straight through.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS_TESTS = [
  // pnpm [options] [exec|dlx] vitest | playwright test
  /^(?:pnpm|npx|pnpx)\b(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+(?:exec\s+|dlx\s+)?(?:vitest|playwright\s+test)\b/,
  // pnpm [options] [run] test | test:e2e | verify
  /^pnpm\b(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+(?:run\s+)?(?:test|test:e2e|verify)(?:\s|$)/,
  // [pnpm [options] [exec]] turbo [run] … test
  /^(?:pnpm\b(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+(?:exec\s+)?)?turbo\s+(?:run\s+)?.*\btest(?::e2e)?\b/,
  /^(?:vitest|playwright\s+test)\b/,
  /^node\s+\S*(?:verify\.mjs|vitest\.mjs|cli\.js\s+test)\b/,
];
const LOCK_FILE = resolve(tmpdir(), 'vertex-digital-verify.lock');
// As in scripts/verify.mjs: past it, the lock is a leftover of a killed run.
const LOCK_MAX_AGE_MS = 45 * 60_000;

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
// A heredoc's text (a commit message, a file) is data, not commands.
const command = String(input.tool_input?.command ?? '').replace(
  /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g,
  '',
);
const parts = command
  .split(/&&|\|\||[;|\n]/)
  .map((part) => part.trim().replace(/^[({]\s*/, ''))
  .map(withoutEnvAssignments)
  .filter(Boolean);
const runsTests = (part) => RUNS_TESTS.some((pattern) => pattern.test(part));

if (parts.some((part) => /^timeout\s/.test(part) && runsTests(afterTimeout(part)))) {
  refuse(
    'Do not wrap a test run in `timeout`: a killed run proves nothing and gets run again. Give ' +
      'the Bash call a timeout long enough for it, or run it in the background and wait for its ' +
      'notification.',
  );
}
const testRuns = parts.filter(runsTests);
if (testRuns.length === 0) process.exit(0);

if (testRuns.some(isWholeE2E)) {
  refuse(
    'The whole E2E suite runs in CI on four shards. Here, run the specs you changed: `pnpm verify` ' +
      'picks them, or `pnpm verify apps/<store or admin>/e2e/<file>.spec.ts [--grep <title>]`. To ' +
      'run every spec here anyway: `pnpm verify --e2e-all`.',
  );
}

const busy = runningTests();
if (busy.length > 0) {
  refuse(
    `A test run is already going: ${busy.join('; ')}. Wait for it to end (its notification or ` +
      'summary) before starting another: two runs share the test databases and the CPU and fail ' +
      "each other's tests.",
  );
}

function withoutEnvAssignments(part) {
  return part.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
}

function afterTimeout(part) {
  return part.replace(/^timeout\s+(?:-\S+\s+)*\S+\s+/, '');
}

/** Playwright with no spec file, test name or changed-only filter: the whole suite. */
function isWholeE2E(part) {
  if (/\bverify\b/.test(part)) return false;
  if (!/\bplaywright\s+test\b|\btest:e2e\b/.test(part)) return false;
  return !/\.spec\.ts\b|(?:^|\s)(?:-g|--grep|--only-changed|--last-failed)\b/.test(part);
}

/** Test processes of this repository (any of its checkouts) that are still running. */
function runningTests() {
  const found = [];
  try {
    const held = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (alive(held.pid) && Date.now() - Date.parse(held.since) < LOCK_MAX_AGE_MS) {
      found.push(`pnpm verify (pid ${held.pid}, since ${held.since}; lock file ${LOCK_FILE})`);
    }
  } catch {
    // No verify run holds the lock.
  }
  const roots = repositoryRoots();
  for (const { pid, args } of processes()) {
    const line = args.replaceAll('\\', '/').toLowerCase();
    if (!roots.some((root) => line.includes(root))) continue;
    if (!/vitest|@playwright\/test|playwright\/cli\.js/.test(line)) continue;
    found.push(`${args.length > 120 ? `${args.slice(0, 117)}…` : args} (pid ${pid})`);
    if (found.length === 3) break;
  }
  return found;
}

/** This checkout and the main one: worktrees share the main checkout's test databases. */
function repositoryRoots() {
  const here = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: here,
    encoding: 'utf8',
    windowsHide: true,
  });
  const main = common.status === 0 ? resolve(common.stdout.trim(), '..') : here;
  return [...new Set([here, main])].map((path) => path.replaceAll('\\', '/').toLowerCase());
}

function processes() {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
          ],
          { encoding: 'utf8', windowsHide: true },
        )
      : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[1]) !== process.pid)
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
