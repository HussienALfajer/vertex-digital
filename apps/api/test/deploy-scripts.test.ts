import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * The server's scripts and files from `deploy/` (audit A10): the health check run with the
 * commands it calls replaced by stubs, and the nginx and PM2 files read as text. `bash` is the
 * server's on Linux and Git Bash on Windows.
 */

const deploy = (path: string) => new URL(`../../../deploy/${path}`, import.meta.url);
const read = (path: string) => readFileSync(deploy(path), 'utf8');
const slash = (path: string) => path.replaceAll('\\', '/');

/** Stubs for every command the health check calls, steered by `FAKE_*` variables. */
const FAKE_DEFAULTS = {
  FAKE_UNIT_DOWN: '0',
  FAKE_API: '200',
  FAKE_STORE: '200',
  FAKE_HEARTBEAT: '1',
  FAKE_DEPLOY_RUNNING: '0',
  FAKE_DISK: '40',
  FAKE_PM2: 'online 0',
};

const STUBS: Record<string, string> = {
  systemctl: 'exit "$FAKE_UNIT_DOWN"',
  curl: [
    'for arg in "$@"; do url=$arg; done',
    'case "$url" in',
    '  *:3060/*) printf "%s" "$FAKE_API" ;;',
    '  *:3061/*) printf "%s" "$FAKE_STORE" ;;',
    '  *) printf 200 ;;',
    'esac',
  ].join('\n'),
  sudo: 'echo "$*" >>"$CALLS"; case "$*" in *jlist*) echo "[]" ;; esac',
  runuser: 'printf "%s" "$FAKE_HEARTBEAT"',
  python3: 'cat >/dev/null; echo "$FAKE_PM2"',
  logger: 'shift 2; echo "$*" >>"$LOGS"',
  flock: 'exit "$FAKE_DEPLOY_RUNNING"',
  df: 'echo "Use%"; echo " $FAKE_DISK%"',
};

let root: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vd-health-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, 'notify'), '#!/bin/bash\necho "$1" >>"$NOTES"\n');
  chmodSync(join(bin, 'notify'), 0o755);
  mkdirSync(join(root, 'site'));
  mkdirSync(join(root, 'backups', '20261028T025008Z'), { recursive: true });
  writeFileSync(join(root, 'backups', 'offsite-last'), '');
  env = {
    STUBS: slash(bin),
    VD_SITE_DIR: slash(join(root, 'site')),
    VD_STATE_DIR: slash(join(root, 'state')),
    VD_BACKUP_DIR: slash(join(root, 'backups')),
    VD_LETSENCRYPT: slash(join(root, 'letsencrypt')),
    VD_NOTIFY: slash(join(bin, 'notify')),
    CALLS: slash(join(root, 'calls')),
    LOGS: slash(join(root, 'logs')),
    NOTES: slash(join(root, 'notes')),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function healthCheck(fake: Record<string, string> = {}) {
  const script = slash(
    new URL(deploy('bin/vertexdigital-healthcheck')).pathname.replace(/^\/(\w:)/, '$1'),
  );
  const run = spawnSync(
    'bash',
    [
      '-c',
      'PATH="$(cygpath -u "$STUBS" 2>/dev/null || echo "$STUBS"):/usr/bin:/bin:$PATH" bash "$0"',
      script,
    ],
    { env: { ...process.env, ...FAKE_DEFAULTS, ...env, ...fake }, encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
}

const lines = (name: 'calls' | 'logs' | 'notes') => {
  try {
    return readFileSync(join(root, name), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const restarts = () => lines('calls').filter((call) => call.includes(' restart '));

describe('the health check (deploy/bin/vertexdigital-healthcheck)', () => {
  it('heals nothing while a restore holds the apps stopped (audit A10-1)', () => {
    writeFileSync(join(root, 'site', '.hold'), 'restore of 20261028T025008Z-1234567');
    healthCheck({ FAKE_API: '000', FAKE_STORE: '000', FAKE_HEARTBEAT: '0' });
    healthCheck({ FAKE_API: '000', FAKE_STORE: '000', FAKE_HEARTBEAT: '0' });
    expect(restarts()).toEqual([]);
    expect(lines('logs')[0]).toContain('held: restore of 20261028T025008Z-1234567');
  });

  it('waits while a deploy holds its lock (audit A10-3)', () => {
    writeFileSync(join(root, 'site', '.deploy.lock'), '');
    healthCheck({ FAKE_API: '000', FAKE_DEPLOY_RUNNING: '1' });
    healthCheck({ FAKE_API: '000', FAKE_DEPLOY_RUNNING: '1' });
    expect(restarts()).toEqual([]);
    expect(lines('logs')).toEqual(
      Array(2).fill('a deploy is running; checked again on the next run'),
    );
  });

  it('restarts the API on its second failed run in a row, and tells the owner once (A10-3, A10-12)', () => {
    healthCheck({ FAKE_API: '000' });
    expect(restarts()).toEqual([]);
    healthCheck({ FAKE_API: '000' });
    expect(restarts()).toEqual([expect.stringContaining('restart vertexdigital-api')]);
    healthCheck({ FAKE_API: '000' });
    healthCheck();
    expect(lines('notes')).toEqual([
      expect.stringContaining('the API answers 000'),
      expect.stringContaining('the API answers again'),
    ]);
  });

  it('a single failed run passes: the count starts again', () => {
    healthCheck({ FAKE_API: '000' });
    healthCheck();
    healthCheck({ FAKE_API: '000' });
    expect(restarts()).toEqual([]);
    expect(lines('notes')).toEqual([]);
  });

  it('never restarts the store when the API is down (audit A10-71)', () => {
    healthCheck({ FAKE_API: '000', FAKE_STORE: '502' });
    healthCheck({ FAKE_API: '000', FAKE_STORE: '502' });
    expect(restarts()).toEqual([expect.stringContaining('restart vertexdigital-api')]);
  });

  it('reports a restart count past 20 once per new count (audit A10-55)', () => {
    healthCheck({ FAKE_PM2: 'online 23' });
    healthCheck({ FAKE_PM2: 'online 23' });
    healthCheck({ FAKE_PM2: 'online 24' });
    const warnings = lines('logs').filter((line) => line.startsWith('warning: vertexdigital-api'));
    expect(warnings).toEqual([
      expect.stringContaining('restarted 23 times'),
      expect.stringContaining('restarted 24 times'),
    ]);
  });

  it('alerts when no complete backup is a day old (audit A10-13)', () => {
    rmSync(join(root, 'backups', '20261028T025008Z'), { recursive: true });
    mkdirSync(join(root, 'backups', '20261028T025008Z.partial'));
    healthCheck();
    healthCheck();
    expect(lines('notes')).toEqual([expect.stringContaining('no complete backup')]);
  });

  it('alerts once when no off-server copy is a day old, and when it is back (Q1)', () => {
    rmSync(join(root, 'backups', 'offsite-last'));
    healthCheck();
    healthCheck();
    writeFileSync(join(root, 'backups', 'offsite-last'), '');
    healthCheck();
    expect(lines('notes')).toEqual([
      expect.stringContaining('no off-server backup copy'),
      expect.stringContaining('off-server backup copies complete again'),
    ]);
  });
});

describe('the backup (deploy/bin/vertexdigital-backup)', () => {
  const script = read('bin/vertexdigital-backup');

  it('uploads only an encrypted archive, checks its hash, then marks the copy (Q1)', () => {
    const encrypt = script.indexOf('--recipient-file "$OFFSITE_KEY"');
    const upload = script.indexOf('rclone copyto');
    expect(encrypt).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(encrypt);
    expect(script.slice(upload)).toContain('rclone copyto --quiet "$archive"');
    expect(script.indexOf('[ "$remote_sha1" = "$local_sha1" ]')).toBeGreaterThan(upload);
    expect(script.indexOf('touch "$DEST/offsite-last"')).toBeGreaterThan(
      script.indexOf('[ "$remote_sha1" = "$local_sha1" ]'),
    );
    // The B2 key never appears in a command's arguments.
    expect(script).not.toMatch(/--b2-(account|key)/);
  });
});

describe('the deploy (deploy/deploy.sh)', () => {
  const script = read('deploy.sh');

  it('holds the health check from a restore until a release is switched to (audit A10-1)', () => {
    const restore = script.slice(script.indexOf('= restore ]'));
    expect(restore.indexOf('>"$HOLD"')).toBeGreaterThan(-1);
    expect(restore.indexOf('>"$HOLD"')).toBeLessThan(restore.indexOf('pm2 stop'));
    expect(script).toMatch(/healthy "\$since"; then rm -f "\$HOLD"; return 0; fi/);
  });

  it('keeps the running release’s hashed static files for open tabs (audit A10-6)', () => {
    expect(script).toContain('keep_static apps/store/.next/static');
    expect(script).toContain('keep_static apps/admin/dist/assets');
    expect(script.indexOf('keep_static apps/store')).toBeLessThan(
      script.indexOf('switch_checked "$release" "$previous"'),
    );
  });
});

describe('PM2 (deploy/ecosystem.config.cjs)', () => {
  it('lets the worker stop pg-boss before it kills it (audit A10-5)', () => {
    const require = createRequire(import.meta.url);
    const { apps } = require(
      new URL(deploy('ecosystem.config.cjs')).pathname.replace(/^\/(\w:)/, '$1'),
    ) as {
      apps: { name: string; kill_timeout: number }[];
    };
    const worker = apps.find((app) => app.name === 'vertexdigital-worker');
    const stop = readFileSync(
      new URL('../../worker/src/core/jobs/pg-boss.service.ts', import.meta.url),
      'utf8',
    ).match(/STOP_TIMEOUT_MS = ([\d_]+)/)?.[1];
    expect(Number(stop?.replaceAll('_', ''))).toBeLessThan((worker?.kill_timeout ?? 0) - 5_000);
  });
});

describe('nginx (deploy/nginx)', () => {
  const sites = ['digital.vertexmedia.pro', 'digital-admin.vertexmedia.pro'];

  it('logs both hosts without query strings or share tokens (audit A10-8)', () => {
    for (const site of [...sites, ...sites.map((name) => `${name}.bootstrap`)]) {
      const logs = [...read(`nginx/${site}`).matchAll(/access_log (\S+)(?: (\S+))?;/g)];
      expect(logs.length).toBeGreaterThan(0);
      for (const [, path, format] of logs) {
        if (path !== 'off') expect(format, `${site}: ${path}`).toBe('vdprivacy');
      }
    }
    const limits = read('nginx/vertexdigital-limits.conf');
    expect(limits).toMatch(/log_format vdprivacy [^;]*\$vd_log_path[^;]*\$vd_log_referer/);
    expect(limits).not.toMatch(
      /log_format vdprivacy [^;]*\$(?:request|request_uri|args|query_string)\b/,
    );
    // The path map, as nginx applies it: the first matching regex wins.
    const map = [...limits.matchAll(/^\s+"~\*(\S+)" (\S+);$/gm)];
    const logged = (uri: string) => {
      for (const [, pattern, value] of map) {
        const match = new RegExp(pattern ?? '', 'i').exec(uri);
        if (match?.groups)
          return (value ?? '').replace(/\$(\w+)/, (_, name) => match.groups?.[name] ?? '');
      }
      return uri;
    };
    expect(logged('/g/7Hq2mXvB0aLp')).toBe('/g/-');
    expect(logged('/v/ABCD-1234')).toBe('/v/-');
    // S23 ID7: the certificate's page and data hide the code; the merchant area does not match.
    expect(logged('/m/abcdefghijklmnopqrstuv')).toBe('/m/-');
    expect(logged('/api/certificates/abcdefghijklmnopqrstuv')).toBe('/api/certificates/-');
    expect(logged('/merchant/tier')).toBe('/merchant/tier');
    expect(logged('/api/shares/7Hq2mXvB0aLp/image')).toBe('/api/shares/-');
    expect(logged('/api/admin/customers')).toBe('/api/admin/customers');
  });

  it('logs rate refusals below the server-wide jail and counts them in its own (audit A10-10)', () => {
    for (const site of sites) {
      expect(read(`nginx/${site}`)).toMatch(
        /limit_req zone=general[^\n]*\n(?:\s*#[^\n]*\n)*\s*limit_req_log_level notice;/,
      );
    }
    const jail = read('fail2ban/jail.d/vertexdigital.conf');
    expect(jail).toContain('[vertexdigital-limit]');
    expect(read('fail2ban/filter.d/vertexdigital-limit.conf')).toContain('" 429 ');
  });

  it('compresses the App Router’s payloads (audit A10-9)', () => {
    for (const file of [
      'vertexdigital-compression-gzip.conf',
      'vertexdigital-compression-brotli.conf',
    ]) {
      const text = read(`nginx/${file}`);
      for (const types of text.matchAll(/(?:gzip|brotli)_types ([^;]+);/g)) {
        expect(types[1]).toContain('text/x-component');
        expect(types[1]).toContain('application/xml');
      }
    }
  });
});
