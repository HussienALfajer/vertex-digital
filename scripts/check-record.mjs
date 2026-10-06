// Records which whole-repo checks passed on which exact working tree, so /ship does not run them
// again on code that has not changed since (.claude/skills/ship/SKILL.md).
//
//   node scripts/check-record.mjs fingerprint              print the working tree's fingerprint
//   node scripts/check-record.mjs record <tree> <check>…   record checks that passed on <tree>
//   node scripts/check-record.mjs status <check>…          per check: "recorded" or "needed"
//
// The fingerprint is the git tree of every tracked and untracked, non-ignored file, written through
// a temporary index seeded from HEAD, so any edit, new file or deletion changes it, except Markdown
// that no check reads (task lists, roadmap, specs; brand/identity.md counts). The record
// lives in the git directory of the current worktree and is never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKS = ['lint', 'typecheck', 'test', 'build', 'e2e', 'drift'];

function print(line) {
  process.stdout.write(`${line}\n`);
}

function git(args, env) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

/**
 * Markdown that no check reads: TASKS.md ticks and ROADMAP.md updates after a full run leave the
 * record valid. brand/identity.md stays in: the design token tests read it (tokens.test.ts).
 */
const UNCHECKED_DOCS = [':(glob)**/*.md', ':(exclude,glob)brand/**'];

/**
 * The git tree of the working tree. `withDocs: false` (the checks' fingerprint) leaves out the
 * Markdown no check reads; `docsOnly` needs every file.
 */
function fingerprint({ withDocs = false } = {}) {
  const index = join(tmpdir(), `vertex-digital-check-index-${process.pid}`);
  try {
    // Start from HEAD so file modes survive where the file system has none (core.fileMode=false).
    git(['read-tree', 'HEAD'], { GIT_INDEX_FILE: index });
    git(['-c', 'core.safecrlf=false', 'add', '--all', '--', '.'], { GIT_INDEX_FILE: index });
    if (!withDocs) {
      git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...UNCHECKED_DOCS], {
        GIT_INDEX_FILE: index,
      });
    }
    return git(['write-tree'], { GIT_INDEX_FILE: index });
  } finally {
    rmSync(index, { force: true });
  }
}

const recordPath = resolve(git(['rev-parse', '--git-path', 'vertex-digital-checks.json']));

function readRecord() {
  if (!existsSync(recordPath)) return {};
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return {};
  }
}

function parseChecks(names) {
  const unknown = names.filter((name) => !CHECKS.includes(name));
  if (names.length === 0 || unknown.length > 0) {
    console.error(`Checks must be among: ${CHECKS.join(', ')}`);
    process.exit(2);
  }
  return names;
}

/** True when every path changed against main is documentation that no check reads. */
function docsOnly(tree) {
  const base = ['origin/main', 'main'].find((ref) => {
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  });
  if (!base) return false;
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const changed = git(['diff', '--name-only', mergeBase, tree]).split('\n').filter(Boolean);
  // brand/identity.md is read by the design token tests (packages/ui tests).
  return changed.length > 0 && changed.every((p) => p.endsWith('.md') && !p.startsWith('brand/'));
}

const [command, ...args] = process.argv.slice(2);

if (command === 'fingerprint') {
  print(fingerprint());
} else if (command === 'record') {
  const [tree, ...names] = args;
  if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) {
    console.error('Usage: record <tree> <check>…');
    process.exit(2);
  }
  const record = readRecord();
  for (const check of parseChecks(names)) {
    record[check] = { tree, at: new Date().toISOString() };
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  print(`recorded ${names.join(', ')} on ${tree.slice(0, 12)}`);
} else if (command === 'status') {
  const checks = parseChecks(args);
  const tree = fingerprint();
  const record = readRecord();
  print(`tree: ${tree.slice(0, 12)}`);
  print(`docs-only: ${docsOnly(fingerprint({ withDocs: true })) ? 'yes' : 'no'}`);
  for (const check of checks) {
    const entry = record[check];
    print(entry?.tree === tree ? `${check}: recorded (passed ${entry.at})` : `${check}: needed`);
  }
} else {
  console.error('Usage: check-record.mjs fingerprint | record <tree> <check>… | status <check>…');
  process.exit(2);
}
