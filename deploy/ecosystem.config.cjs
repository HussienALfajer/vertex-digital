// PM2 processes for production (docs/deployment.md). Run by the `vertexdigital` user from the
// `current` release; the environment comes from the release's .env (a link to shared/.env).
// Memory limits are per process: the server is shared with other sites (ADR 0009).
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
  // Nest shutdown hooks close the HTTP server, pg-boss and the database pool.
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
      out_file: `${logs}/api.out.log`,
      error_file: `${logs}/api.err.log`,
    },
    {
      ...common,
      name: 'vertexdigital-worker',
      script: 'apps/worker/dist/main.js',
      max_memory_restart: '384M',
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
