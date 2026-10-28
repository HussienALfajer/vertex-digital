// Biome over the repository, as CI runs it. Biome honours git's ignore files, including this
// machine's `info/exclude`, where tools may add lines (`reports/`) that hide tracked source
// folders; CI has no such lines and lints them. So the tracked files that file hides get a second
// pass with the ignore files off: the local result matches CI's. (A new file there is hidden from
// git too: `git add -f` it, then it is tracked and linted.)
//   node scripts/lint.mjs [biome options]   (`pnpm lint`, `pnpm lint:fix` passes --write)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'node_modules', '@biomejs', 'biome', 'package.json');
const biome = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.biome);
const options = ['check', '--error-on-warnings', ...process.argv.slice(2)];

const biomeRun = (args) =>
  spawnSync(process.execPath, [biome, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? '';

let status = biomeRun([...options, '.']);

// In a worktree `.git` is a file: ask git where its exclude file is.
const path = git(['rev-parse', '--git-path', 'info/exclude']).trim();
const exclude = path && (isAbsolute(path) ? path : join(root, path));
if (exclude && existsSync(exclude)) {
  const hidden = git(['ls-files', '-z', '-i', '-c', `--exclude-from=${exclude}`])
    .split('\0')
    .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(file));
  if (hidden.length > 0) {
    const second = ['--vcs-use-ignore-file=false', '--no-errors-on-unmatched', ...hidden];
    status = Math.max(status, biomeRun([...options, ...second]));
  }
}

process.exit(status);
