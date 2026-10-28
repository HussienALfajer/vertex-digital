// PM2 processes for production (docs/deployment.md). Run by the `vertexdigital` user from the
// `current` release; the environment comes from the release's .env (a link to shared/.env).
// Memory limits are per process: the server is shared with other sites (ADR 0009). The api and
// worker cap V8's heap below their PM2 limit: with the default (gigabytes) V8 put off collecting
// while a large supplier sync ran, and PM2 killed the worker mid-run for memory that was garbage.
// Set through NODE_OPTIONS because `startOrReload --update-env` applies env, not node_args.
const root = '/srv/digital.vertexmedia.pro/current';
const logs = '/var/log/digital.vertexmedia.pro';

const common = {
  cwd: root,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '20s',
  exp_backoff_restart_delay: 200,
  // Nest shutdown hooks close the HTTP server, pg-boss and the database pool. The worker waits
  // longer: pg-boss lets its running jobs finish for up to 25 s (`pg-boss.service.ts`) before
  // the pool closes, and PM2 killed it mid-job at 15 s on every deploy (audit A10-5).
  kill_timeout: 15000,
  time: true,
  merge_logs: true,
  // Set here as well as in .env: production behaviour never depends on one hand-edited file.
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'vertexdigital-api',
      script: 'apps/api/dist/main.js',
      max_memory_restart: '512M',
      env: { ...common.env, NODE_OPTIONS: '--max-old-space-size=384' },
      out_file: `${logs}/api.out.log`,
      error_file: `${logs}/api.err.log`,
    },
    {
      ...common,
      name: 'vertexdigital-worker',
      script: 'apps/worker/dist/main.js',
      // A WDG sync (11,595 offers) peaks near 350 MB with the 256 MB heap (measured 2026-10-14).
      max_memory_restart: '512M',
      env: { ...common.env, NODE_OPTIONS: '--max-old-space-size=256' },
      kill_timeout: 35000,
      out_file: `${logs}/worker.out.log`,
      error_file: `${logs}/worker.err.log`,
    },
    {
      ...common,
      name: 'vertexdigital-store',
      cwd: `${root}/apps/store`,
      script: 'node_modules/next/dist/bin/next',
      // The port is the store's slot in the server's port map (docs/deployment.md).
      args: 'start --hostname 127.0.0.1 --port 3061',
      max_memory_restart: '512M',
      out_file: `${logs}/store.out.log`,
      error_file: `${logs}/store.err.log`,
    },
  ],
};
