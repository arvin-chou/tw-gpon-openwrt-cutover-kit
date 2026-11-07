import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../odi-scripts/gpon_cutover_monitor.mjs', import.meta.url));

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
  });
}

async function createFakeSsh(directory) {
  const executable = join(directory, 'ssh');
  await writeFile(executable, `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$FAKE_SSH_MODE" = 'remote_command_ceiling' ] &&
  [ "$(printf %s "$last" | wc -c | tr -d '[:space:]')" -gt 1023 ]; then
  exit 255
fi
case "$last" in
  *'diag gpon get onu-state'*)
    if [ "$FAKE_SSH_MODE" = 'stderr_o5_only' ]; then
      printf '%s\n' 'ONU state: Operation State(O5)' >&2
    else
      printf '%s\n' 'ONU state: Initial State(O1)'
    fi
    ;;
  *LOCAL_VLAN_COMPLETE*)
    printf '%s\n' \\
      '===LOCAL_VLAN_FLASH===' \\
      'VLAN_CFG_TYPE=1' \\
      'VLAN_MANU_MODE=1' \\
      'VLAN_MANU_TAG_VID=2769' \\
      'VLAN_MANU_TAG_PRI=255' \\
      '===LOCAL_VLAN_MIB===' \\
      'VLAN_CFG_TYPE=1' \\
      'VLAN_MANU_MODE=1' \\
      'VLAN_MANU_TAG_VID=2769' \\
      'VLAN_MANU_TAG_PRI=255' \\
      '===LOCAL_VLAN_COMPLETE==='
    ;;
  *)
    if [ "$FAKE_SSH_MODE" = 'ssh_failure_no_output' ]; then
      exit 255
    fi
    printf '%s\n' \\
      '===PROC===' \\
      '===OMCI_APP_CMDLINE===' \\
      'PID=321 TGID=321 PPID=1 CMDLINE=omci_app' \\
      '===ME:2===' \\
      '===ME:7===' \\
      '===ME:84===' \\
      'Entity ID: 0x03' \\
      'FilterTbl[0]: PRI 0,CFI 0, VID 2769' \\
      '===ME:131===' \\
      '===ME:171===' \\
      'Entity ID: 0x0301' \\
      '===ME:256==='
    if [ "$FAKE_SSH_MODE" != 'missing_me' ]; then
      printf '%s\n' '===ME:257==='
    fi
    printf '%s\n' \\
      '===ME:262===' \\
      'Entity ID: 0x8000' \\
      'AllocID: 0x0103' \\
      '===ME:268==='
    if [ "$FAKE_SSH_MODE" != 'stderr_gem_only' ]; then
      printf '%s\n' 'Entity ID: 0x0110'
    else
      printf '%s\n' 'Entity ID: 0x0110' >&2
    fi
    if [ "$FAKE_SSH_MODE" != 'missing_terminal' ]; then
      printf '%s\n' '===SNAPSHOT_COMPLETE==='
    fi
    if [ "$FAKE_SSH_MODE" = 'trailing_after_terminal' ]; then
      printf '%s\n' 'unexpected trailing output'
    fi
    ;;
esac
`, { mode: 0o700 });
  await chmod(executable, 0o700);
}

async function runSnapshotCase(mode) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<b>ONU State</b><td><font>O5</font></td>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const directory = await mkdtemp(join(tmpdir(), 'gpon-monitor-snapshot-test-'));
  await createFakeSsh(directory);
  const socketPath = join(directory, 'master.sock');
  const socketServer = net.createServer();
  socketServer.listen(socketPath);
  await once(socketServer, 'listening');
  const output = join(directory, 'evidence.jsonl');
  const doneMarker = join(directory, 'done.json');
  const { port } = server.address();
  const child = spawn(process.execPath, [
    SCRIPT,
    '--once',
    '--endpoint', `http://127.0.0.1:${port}`,
    '--stick-control-socket', socketPath,
    '--expected-manual-vid', '2769',
    '--output', output,
    '--done-marker', doneMarker,
  ], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_SSH_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  server.close();
  socketServer.close();
  return {
    exitCode,
    event: JSON.parse(stdout.trim()),
    stderr,
  };
}

test('rejects high-frequency polling unless --once is used', () => {
  const result = run('--interval-sec', '5');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be >= 30/);
});

test('rejects O5 as a success/stop condition', () => {
  const result = run('--stop-on-o5');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /O5 is not subscriber-service closure/);
});

test('requires an existing ControlMaster path for O5 snapshots', () => {
  const result = run('--snapshot-on-o5');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --stick-control-socket/);
});

test('requires a ControlMaster path for SSH status transport', () => {
  const result = run('--status-via-stick-ssh', '--once');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --stick-control-socket/);
});

test('rejects an invalid expected Manual PVID', () => {
  for (const value of ['0', '4095', 'not-a-vid']) {
    const result = run('--expected-manual-vid', value, '--once');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /integer from 1 to 4094/);
  }
});

test('requires a ControlMaster path for an expected Manual PVID', () => {
  const result = run('--expected-manual-vid', '2769', '--once');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --stick-control-socket/);
});

test('Router consumer closure requires every explicit safety flag', () => {
  const missingRouterSocket = run('--router-consumer-on-ready');
  assert.equal(missingRouterSocket.status, 2);
  assert.match(missingRouterSocket.stderr, /requires --router-control-socket/);

  const wrongVid = run(
    '--router-consumer-on-ready',
    '--router-control-socket', '/tmp/router.sock',
    '--router-host', 'root@router-b.local',
    '--stick-control-socket', '/tmp/stick.sock',
    '--snapshot-on-o5',
    '--status-via-stick-ssh',
    '--expected-manual-vid', '2770',
  );
  assert.equal(wrongVid.status, 2);
  assert.match(wrongVid.stderr, /requires --expected-manual-vid 2769/);

  const once = run(
    '--router-consumer-on-ready',
    '--router-control-socket', '/tmp/router.sock',
    '--router-host', 'root@router-b.local',
    '--stick-control-socket', '/tmp/stick.sock',
    '--snapshot-on-o5',
    '--status-via-stick-ssh',
    '--expected-manual-vid', '2769',
    '--once',
  );
  assert.equal(once.status, 2);
  assert.match(once.stderr, /cannot be used with --once/);

  const httpStatus = run(
    '--router-consumer-on-ready',
    '--router-control-socket', '/tmp/router.sock',
    '--router-host', 'root@router-b.local',
    '--stick-control-socket', '/tmp/stick.sock',
    '--snapshot-on-o5',
    '--expected-manual-vid', '2769',
  );
  assert.equal(httpStatus.status, 2);
  assert.match(httpStatus.stderr, /requires --status-via-stick-ssh/);
});

test('Router socket and host are inert without the explicit consumer opt-in', () => {
  const result = run(
    '--router-control-socket', '/tmp/router.sock',
    '--router-host', 'root@router-b.local',
    '--once',
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /require explicit --router-consumer-on-ready/);
});

test('Router consumer requires durable state and rejects an already consumed attempt', async t => {
  const validRouterArgs = [
    '--router-consumer-on-ready',
    '--router-control-socket', '/tmp/router.sock',
    '--router-host', 'root@router-b.local',
    '--stick-control-socket', '/tmp/stick.sock',
    '--snapshot-on-o5',
    '--status-via-stick-ssh',
    '--expected-manual-vid', '2769',
  ];
  let result = run(...validRouterArgs);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /persistent --done-marker outside temporary storage/);

  const directory = await mkdtemp(join(process.cwd(), '.gpon-monitor-state-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const doneMarker = join(directory, 'cutover.done');
  await writeFile(`${doneMarker}.router-attempt`, '{"consumed":true}\n', { mode: 0o600 });
  result = run(...validRouterArgs, '--done-marker', doneMarker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /attempt marker already exists/);

  const symlinkDirectory = await mkdtemp(join(process.cwd(), '.gpon-monitor-symlink-test-'));
  const temporaryTarget = await mkdtemp(join(tmpdir(), 'gpon-monitor-state-target-'));
  t.after(() => Promise.all([
    rm(symlinkDirectory, { recursive: true, force: true }),
    rm(temporaryTarget, { recursive: true, force: true }),
  ]));
  const stateLink = join(symlinkDirectory, 'state-link');
  await symlink(temporaryTarget, stateLink, 'dir');
  result = run(...validRouterArgs, '--done-marker', join(stateLink, 'cutover.done'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /persistent --done-marker outside temporary storage/);
});

test('rejects evidence output that aliases the completion marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpon-monitor-alias-test-'));
  const samePath = join(directory, 'same-file');
  let result = run('--once', '--output', samePath, '--done-marker', samePath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must differ/);

  const output = join(directory, 'evidence.jsonl');
  const doneMarker = join(directory, 'done.json');
  await writeFile(output, '');
  await link(output, doneMarker);
  result = run('--once', '--output', output, '--done-marker', doneMarker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not be hard links/);
});

test('refuses to reuse an existing evidence file or done marker', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'gpon-monitor-output-reuse-test-'));
  const doneDirectory = await mkdtemp(join(tmpdir(), 'gpon-monitor-done-reuse-test-'));
  t.after(() => Promise.all([
    rm(outputDirectory, { recursive: true, force: true }),
    rm(doneDirectory, { recursive: true, force: true }),
  ]));

  const oldOutput = join(outputDirectory, 'evidence.jsonl');
  const freshDone = join(outputDirectory, 'done.json');
  await writeFile(oldOutput, 'prior evidence\n', { mode: 0o600 });
  let result = run('--once', '--output', oldOutput, '--done-marker', freshDone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing evidence reuse/);
  assert.equal(await readFile(oldOutput, 'utf8'), 'prior evidence\n');
  await assert.rejects(stat(freshDone), { code: 'ENOENT' });
  await assert.rejects(stat(`${freshDone}.lock`), { code: 'ENOENT' });

  const freshOutput = join(doneDirectory, 'evidence.jsonl');
  const oldDone = join(doneDirectory, 'done.json');
  await writeFile(oldDone, '{"status":"prior"}\n', { mode: 0o600 });
  result = run('--once', '--output', freshOutput, '--done-marker', oldDone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing evidence reuse/);
  assert.equal(await readFile(oldDone, 'utf8'), '{"status":"prior"}\n');
  await assert.rejects(stat(freshOutput), { code: 'ENOENT' });
  await assert.rejects(stat(`${oldDone}.lock`), { code: 'ENOENT' });
});

test('rejects an invalid snapshot completion deadline', () => {
  for (const value of ['0', '-1', 'not-a-number']) {
    const result = run('--snapshot-timeout-sec', value, '--once');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /snapshot-timeout-sec must be > 0/);
  }
});

test('rejects values that overflow the Node timer range', () => {
  let result = run('--interval-sec', '2147484');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interval-sec exceeds the safe Node timer range/);

  result = run('--snapshot-timeout-sec', '2147484', '--once');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /snapshot-timeout-sec exceeds the safe Node timer range/);
});

test('help documents consumer closure and the safe polling floor', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ME84\/171, T-CONT and GEM/);
  assert.match(result.stdout, /--interval-sec 30/);
  assert.match(result.stdout, /--status-via-stick-ssh/);
  assert.match(result.stdout, /--expected-manual-vid VID/);
  assert.match(result.stdout, /--router-consumer-on-ready/);
  assert.match(result.stdout, /fixed 15-second netifd WAN probe/);
  assert.match(result.stdout, /first qualifies an off-fibre/);
  assert.match(result.stdout, /status=armed_for_fiber_move/);
  assert.match(result.stdout, /--router-control-socket PATH/);
  assert.match(result.stdout, /--router-host HOST/);
  assert.match(result.stdout, /snapshot \(default: 5\)/);
  assert.doesNotMatch(result.stdout, /--stop-on-o5/);
});

test('--once records O5 but does not claim subscriber-service closure', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/status_pon.asp');
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <b>ONU State</b><td><font>O5</font></td>
      <b>ONU ID</b><td><font>42</font></td>
      <b>Rx Power</b><td><font>-19.4 dBm</font></td>
      <b>Tx Power</b><td><font>2.1 dBm</font></td>
    `);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const directory = await mkdtemp(join(tmpdir(), 'gpon-monitor-test-'));
  const output = join(directory, 'evidence.jsonl');
  const doneMarker = join(directory, 'done.json');
  const { port } = server.address();
  const child = spawn(process.execPath, [
    SCRIPT,
    '--once',
    '--endpoint', `http://127.0.0.1:${port}`,
    '--output', output,
    '--done-marker', doneMarker,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  server.close();

  assert.equal(exitCode, 0, stderr);
  const event = JSON.parse(stdout.trim());
  const result = JSON.parse(await readFile(doneMarker, 'utf8'));
  assert.equal(event.onuState, 'O5');
  assert.equal(event.consumerSnapshot, undefined);
  assert.equal(typeof event.runId, 'string');
  assert.equal(event.runId, result.runId);
  assert.equal(event.runStartedAt, result.runStartedAt);
  assert.equal(event.lastSampleOk, true);
  assert.equal(event.consecutiveO5Samples, 1);
  assert.equal(event.o5Stable, false);
  assert.equal(result.o5Observed, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.lastSampleOk, true);
  assert.equal(result.o5OmciSnapshotTaken, false);
  assert.equal(result.lastOmciProvisioningGate, 'unknown');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(doneMarker)).mode & 0o777, 0o600);
  assert.match(stderr, /subscriber service still requires router-consumer evidence/);
});

test('stick SSH stderr cannot manufacture O5 status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpon-monitor-ssh-status-test-'));
  await createFakeSsh(directory);
  const socketPath = join(directory, 'master.sock');
  const socketServer = net.createServer();
  socketServer.listen(socketPath);
  await once(socketServer, 'listening');
  const output = join(directory, 'evidence.jsonl');
  const doneMarker = join(directory, 'done.json');
  const child = spawn(process.execPath, [
    SCRIPT,
    '--once',
    '--status-via-stick-ssh',
    '--stick-control-socket', socketPath,
    '--output', output,
    '--done-marker', doneMarker,
  ], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_SSH_MODE: 'stderr_o5_only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  socketServer.close();

  assert.equal(exitCode, 1);
  const event = JSON.parse(stdout.trim());
  assert.equal(event.ok, false);
  assert.equal(event.error, 'diag output did not contain ONU state');
  assert.equal(event.onuState, undefined);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /Operation State\(O5\)/);
});

test('done-marker lease rejects a concurrent run and preserves the owner result', async () => {
  let releaseResponse;
  let markRequestSeen;
  const requestSeen = new Promise(resolve => { markRequestSeen = resolve; });
  const server = http.createServer((_request, response) => {
    releaseResponse = () => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<b>ONU State</b><td><font>O1</font></td>');
    };
    markRequestSeen();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const directory = await mkdtemp(join(tmpdir(), 'gpon-monitor-lease-test-'));
  const output = join(directory, 'evidence.jsonl');
  const doneMarker = join(directory, 'done.json');
  const args = [
    SCRIPT,
    '--once',
    '--endpoint', `http://127.0.0.1:${server.address().port}`,
    '--output', output,
    '--done-marker', doneMarker,
  ];
  const owner = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let ownerStderr = '';
  owner.stderr.on('data', chunk => { ownerStderr += chunk; });
  await requestSeen;

  const running = JSON.parse(await readFile(doneMarker, 'utf8'));
  assert.equal(running.status, 'running');
  assert.equal(Number.isInteger(running.pid), true);
  assert.equal((await stat(`${doneMarker}.lock`)).mode & 0o777, 0o600);

  const contender = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5_000 });
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /run lease already exists; refusing automatic recovery/);
  assert.equal(JSON.parse(await readFile(doneMarker, 'utf8')).runId, running.runId);

  releaseResponse();
  const [ownerExitCode] = await once(owner, 'close');
  server.close();
  assert.equal(ownerExitCode, 0, ownerStderr);
  const completed = JSON.parse(await readFile(doneMarker, 'utf8'));
  assert.equal(completed.status, 'complete');
  assert.equal(completed.runId, running.runId);
  await assert.rejects(stat(`${doneMarker}.lock`), { code: 'ENOENT' });
});

test('complete O5 snapshot emits only structured evidence, never raw device output', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('complete');
  assert.equal(exitCode, 0, stderr);
  assert.equal(event.consumerSnapshotError, undefined);
  assert.equal(event.consumerSnapshot.localIngressGate, 'ready');
  assert.equal(event.consumerSnapshot.omciProvisioningGate, 'ready');
  assert.equal(event.consumerSnapshot.subscriberServiceGate, 'pending_router_consumer');
  assert.equal(event.consumerSnapshot.raw, undefined);
  assert.equal(event.consumerSnapshot.omciAppCommandLines.entries[0].command, undefined);
  assert.deepEqual(event.consumerSnapshot.omciAppCommandLines.entries[0], {
    pid: 321,
    tgid: 321,
    ppid: 1,
    isOmciApp: true,
    manualType: null,
    manualTypePresenceCount: 0,
    manualMode: null,
    manualModePresenceCount: 0,
    manualVid: null,
    manualVidPresenceCount: 0,
    manualPriority: null,
    manualPriorityPresenceCount: 0,
  });
  assert.equal(event.o5OmciSnapshotTaken, true);
});

test('O5 snapshot fits an embedded remote-exec command ceiling', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('remote_command_ceiling');
  assert.equal(exitCode, 0, stderr);
  assert.equal(event.consumerSnapshotError, undefined);
  assert.equal(event.consumerSnapshot.gates.acquisitionValidated, true);
  assert.equal(event.o5OmciSnapshotTaken, true);
});

test('SSH failure without stdout is reported as pre-structured failure', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('ssh_failure_no_output');
  assert.equal(exitCode, 1, stderr);
  assert.equal(event.consumerSnapshotError, 'remote snapshot command failed before structured output');
  assert.equal(event.consumerSnapshot, undefined);
  assert.equal(event.o5OmciSnapshotTaken, false);
});

test('successful SSH exit without the terminal marker fails closed with a sanitized error', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('missing_terminal');
  assert.equal(exitCode, 1, stderr);
  assert.equal(event.consumerSnapshotError, 'remote snapshot command failed before structured output');
  assert.equal(event.consumerSnapshot, undefined);
  assert.equal(event.o5OmciSnapshotTaken, false);
  assert.equal(event.lastOmciProvisioningGate, 'unknown');
});

test('an early completion marker followed by output fails closed with a sanitized error', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('trailing_after_terminal');
  assert.equal(exitCode, 1, stderr);
  assert.equal(event.consumerSnapshotError, 'remote snapshot command failed before structured output');
  assert.equal(event.consumerSnapshot, undefined);
  assert.equal(event.o5OmciSnapshotTaken, false);
});

test('O5 snapshot missing one expected ME marker fails closed', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('missing_me');
  assert.equal(exitCode, 1, stderr);
  assert.match(event.consumerSnapshotError, /remote O5 snapshot incomplete/);
  assert.match(event.consumerSnapshotError, /expected ME markers/);
  assert.equal(event.consumerSnapshot, undefined);
  assert.equal(event.o5OmciSnapshotTaken, false);
  assert.equal(event.lastOmciProvisioningGate, 'unknown');
});

test('SSH stderr cannot manufacture a GEM entity in the parsed snapshot', async () => {
  const { exitCode, event, stderr } = await runSnapshotCase('stderr_gem_only');
  assert.equal(exitCode, 0, stderr);
  assert.equal(event.consumerSnapshotError, undefined);
  assert.equal(event.consumerSnapshot.entityCounts['268'], 0);
  assert.equal(event.consumerSnapshot.gates.gemProvisioned, false);
  assert.equal(event.consumerSnapshot.omciProvisioningGate, 'blocked');
});
