#!/usr/bin/env node
// Local dev runner.
//
// Opens an SSH tunnel to the freemap MariaDB on the host configured below,
// then launches the regular `tsc-watch` + `dev:serve` chain. Both processes
// are torn down together on Ctrl-C, signal, or when either side exits.
//
// All knobs can be overridden with environment variables so this works
// for other developers' SSH configs without code changes.

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const SSH_HOST = process.env.MARIADB_SSH_HOST ?? 'sano-server';
const LOCAL_PORT = Number(process.env.MARIADB_TUNNEL_LOCAL_PORT ?? 3307);
const REMOTE_HOST = process.env.MARIADB_TUNNEL_REMOTE_HOST ?? '127.0.0.1';
const REMOTE_PORT = Number(process.env.MARIADB_TUNNEL_REMOTE_PORT ?? 3306);
const TUNNEL_READY_TIMEOUT_MS = Number(
  process.env.MARIADB_TUNNEL_READY_TIMEOUT_MS ?? 15_000,
);

let shuttingDown = false;
let tunnel = null;
let child = null;

function log(msg) {
  console.log(`[dev] ${msg}`);
}

function logErr(msg) {
  console.error(`[dev] ${msg}`);
}

function probe(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const finish = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

async function waitForTunnel(port, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await probe(port)) return true;
    if (tunnel && tunnel.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (child && child.exitCode === null) {
    try {
      child.kill('SIGINT');
    } catch {}
  }
  if (tunnel && tunnel.exitCode === null) {
    try {
      tunnel.kill('SIGTERM');
    } catch {}
  }

  setTimeout(() => process.exit(code), 750).unref();
}

log(
  `opening SSH tunnel: 127.0.0.1:${LOCAL_PORT} -> ${SSH_HOST}:${REMOTE_HOST}:${REMOTE_PORT}`,
);

tunnel = spawn(
  'ssh',
  [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}`,
    SSH_HOST,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

tunnel.once('exit', (code, signal) => {
  if (shuttingDown) return;
  logErr(`SSH tunnel exited (code=${code}, signal=${signal}); shutting down`);
  shutdown(typeof code === 'number' ? code : 1);
});

const ready = await waitForTunnel(LOCAL_PORT, TUNNEL_READY_TIMEOUT_MS);

if (!ready) {
  logErr(
    `tunnel did not come up on 127.0.0.1:${LOCAL_PORT} within ${TUNNEL_READY_TIMEOUT_MS}ms`,
  );
  shutdown(1);
} else {
  log(`tunnel ready on 127.0.0.1:${LOCAL_PORT}`);

  child = spawn('pnpm', ['run', 'dev:tsc'], { stdio: 'inherit' });

  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`dev process exited (code=${code}, signal=${signal})`);
    shutdown(typeof code === 'number' ? code : 0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log(`received ${sig}, tearing down`);
    shutdown(0);
  });
}
