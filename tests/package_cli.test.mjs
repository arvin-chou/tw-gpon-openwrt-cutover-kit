import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'bin/gpon-cutover.mjs');
const AUDIT = resolve(ROOT, 'scripts/release-audit.mjs');

async function unixServer(path) {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, resolveListen);
  });
  return server;
}

test('help documents explicit apply, rollback, and exit codes', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--help']);
  assert.match(stdout, /cutover --apply/);
  assert.match(stdout, /rolls WAN back/);
  assert.match(stdout, /Exit codes:/);
});

test('cutover refuses to run without explicit apply', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, 'cutover']),
    error => error.code === 2 && /requires explicit --apply/.test(error.stderr),
  );
});

test('dry-run wires only existing ControlMaster sockets into the proven monitor', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'tw-gpon-package-test-'));
  const stickSocket = join(directory, 'stick.sock');
  const routerSocket = join(directory, 'router.sock');
  const [stickServer, routerServer] = await Promise.all([
    unixServer(stickSocket),
    unixServer(routerSocket),
  ]);
  try {
    const envPath = join(directory, 'test.env');
    await writeFile(envPath, [
      'GPON_PROFILE=xiaomi-be10000-qwrt-cht',
      'GPON_STICK_HOST=admin@stick.test',
      `GPON_STICK_CONTROL_SOCKET=${stickSocket}`,
      'GPON_ROUTER_HOST=root@router.test',
      `GPON_ROUTER_CONTROL_SOCKET=${routerSocket}`,
      'GPON_EXPECTED_MANUAL_VID=2769',
      'GPON_INTERVAL_SEC=30',
      'GPON_DURATION_SEC=300',
      `GPON_STATE_DIR=${join(directory, 'state')}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const { stdout } = await execFileAsync(process.execPath, [
      CLI,
      'cutover',
      '--apply',
      '--dry-run',
      '--env', envPath,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.mutatesRouter, true);
    assert.match(result.backup, /network-backup\.tgz$/);
    assert.ok(result.args.includes('--router-consumer-on-ready'));
    assert.ok(result.args.includes('--snapshot-on-o5'));
    assert.ok(result.args.includes('--expected-manual-vid'));
    assert.doesNotMatch(stdout, /password|private key/i);
  } finally {
    await Promise.all([
      new Promise(resolveClose => stickServer.close(resolveClose)),
      new Promise(resolveClose => routerServer.close(resolveClose)),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('ambient GPON settings cannot redirect configuration loaded from --env', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'tw-gpon-package-env-test-'));
  const stickSocket = join(directory, 'stick.sock');
  const routerSocket = join(directory, 'router.sock');
  const stateDirectory = join(directory, 'state-from-file');
  const [stickServer, routerServer] = await Promise.all([
    unixServer(stickSocket),
    unixServer(routerSocket),
  ]);
  try {
    const envPath = join(directory, 'test.env');
    await writeFile(envPath, [
      'GPON_PROFILE=xiaomi-be10000-qwrt-cht',
      'GPON_STICK_HOST=admin@stick.test',
      `GPON_STICK_CONTROL_SOCKET=${stickSocket}`,
      'GPON_ROUTER_HOST=root@router.test',
      `GPON_ROUTER_CONTROL_SOCKET=${routerSocket}`,
      'GPON_EXPECTED_MANUAL_VID=2769',
      'GPON_INTERVAL_SEC=30',
      'GPON_DURATION_SEC=300',
      `GPON_STATE_DIR=${stateDirectory}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const { stdout } = await execFileAsync(process.execPath, [
      CLI,
      'cutover',
      '--apply',
      '--dry-run',
      '--env', envPath,
    ], {
      env: {
        ...process.env,
        GPON_PROFILE: 'hostile-profile',
        GPON_STICK_HOST: 'admin@hostile.test',
        GPON_STICK_CONTROL_SOCKET: join(directory, 'hostile-stick.sock'),
        GPON_ROUTER_HOST: 'root@hostile.test',
        GPON_ROUTER_CONTROL_SOCKET: join(directory, 'hostile-router.sock'),
        GPON_STATE_DIR: join(directory, 'hostile-state'),
      },
    });
    const result = JSON.parse(stdout);
    const argumentAfter = flag => result.args[result.args.indexOf(flag) + 1];
    assert.equal(argumentAfter('--stick-host'), 'admin@stick.test');
    assert.equal(argumentAfter('--stick-control-socket'), stickSocket);
    assert.equal(argumentAfter('--router-host'), 'root@router.test');
    assert.equal(argumentAfter('--router-control-socket'), routerSocket);
    assert.equal(argumentAfter('--output').startsWith(`${stateDirectory}/`), true);
    assert.equal(result.backup.startsWith(`${stateDirectory}/`), true);
  } finally {
    await Promise.all([
      new Promise(resolveClose => stickServer.close(resolveClose)),
      new Promise(resolveClose => routerServer.close(resolveClose)),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('release audit rejects no files in the staged package', async () => {
  const { stdout } = await execFileAsync(process.execPath, [AUDIT]);
  const result = JSON.parse(stdout);
  assert.equal(result.gate, 'ready');
  assert.equal(result.secretsFound, 0);
  assert.ok(result.filesScanned >= 10);
});
