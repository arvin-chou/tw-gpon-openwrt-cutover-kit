import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  consumeRouterAttempt,
  isStableO5Sequence,
  ROUTER_CONSUMER_TIMEOUT_SEC,
  ROUTER_CLEANUP_OWNER_WAIT_SEC,
  ROUTER_PROBE_KILL_GRACE_SEC,
  ROUTER_PROBE_TIMEOUT_MS,
  ROUTER_PROBE_WATCHDOG_SEC,
  ROUTER_ROLLBACK_SETTLE_SEC,
  ROUTER_ROLLBACK_TIMEOUT_MS,
  runRouterPreflight,
  runRouterRollback,
  runRouterWanProbe,
} from '../lib/gpon-router-consumer.js';

const OWNERSHIP_TOKEN = '00000000-0000-4000-8000-000000000001';

function fakeSsh(outputs) {
  const calls = [];
  const executeFile = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('-O')) return { stdout: 'Master running\n', stderr: '' };
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return { stdout: output ?? '', stderr: '' };
  };
  return { calls, executeFile };
}

function remoteScript(call) {
  assert.deepEqual(call.args.slice(-2), ['sh', '-s']);
  assert.equal(typeof call.options.input, 'string');
  return call.options.input;
}

function probeOutput(overrides = {}) {
  const values = {
    ROUTER_CONSUMER: 'ready',
    PRECHECK: 'ready',
    IFUP_OK: 'true',
    PADO: 'confirmed_by_session',
    WAN_IPV4: 'true',
    DNS: 'true',
    HTTP: 'true',
    ROUTE: 'true',
    ROLLBACK: 'not_required',
    LOCK: 'retained',
    ...overrides,
  };
  return [
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '===ROUTER_CONSUMER_COMPLETE===',
    '',
  ].join('\n');
}

function commitOutput(overrides = {}) {
  return [
    `COMMIT=${overrides.COMMIT ?? 'ready'}`,
    '===ROUTER_COMMIT_COMPLETE===',
    '',
  ].join('\n');
}

function rollbackOutput(overrides = {}) {
  const values = {
    ROLLBACK: 'ready',
    UBUS: 'ok',
    WAN_UP: 'false',
    WAN_PENDING: 'false',
    WAN_DEVICE: 'eth5',
    PPPD: 'absent',
    ETH5_UP: 'true',
    ETH5_CARRIER: 'true',
    STICK_REACHABLE: 'true',
    AUTO0: 'true',
    ...overrides,
  };
  return [
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '===ROUTER_ROLLBACK_COMPLETE===',
    '',
  ].join('\n');
}

function replaceExactlyOnce(value, before, after) {
  assert.equal(value.split(before).length, 2, `expected one occurrence of ${before}`);
  return value.replace(before, after);
}

function fakeProcStat(starttime) {
  return `${Array.from({ length: 22 }, (_, index) => (
    index === 21 ? starttime : '0'
  )).join(' ')}\n`;
}

async function runRollbackIdentityHarness(rollbackScript, {
  claimedStarttime,
  observedStarttime,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'gpon-router-rollback-identity-'));
  const lockPath = join(directory, 'lock');
  const claimPath = join(directory, 'claim');
  const procRoot = join(directory, 'proc');
  const eventsPath = join(directory, 'events');
  const ownerPid = '410001';
  const ownerStarttime = '10101';
  const mutatorPid = '410002';

  try {
    await mkdir(join(claimPath, `probe.${ownerPid}.${ownerStarttime}`), { recursive: true });
    await mkdir(join(claimPath, `mutator.${mutatorPid}.${claimedStarttime}`));
    await mkdir(join(procRoot, mutatorPid), { recursive: true });
    await writeFile(lockPath, `${OWNERSHIP_TOKEN}:mutating:${ownerPid}\n`);
    await writeFile(join(procRoot, mutatorPid, 'stat'), fakeProcStat(observedStarttime));
    await writeFile(eventsPath, '');

    let redirectedScript = replaceExactlyOnce(
      rollbackScript,
      'lock_path=/tmp/gpon-router-consumer.lock',
      'lock_path="$GPON_TEST_LOCK_PATH"',
    );
    redirectedScript = replaceExactlyOnce(
      redirectedScript,
      'claim_path="/tmp/gpon-router-consumer.claim.$lock_token"',
      'claim_path="$GPON_TEST_CLAIM_PATH"',
    );
    redirectedScript = replaceExactlyOnce(
      redirectedScript,
      '"/proc/$identity_pid/stat"',
      '"$GPON_TEST_PROC_ROOT/$identity_pid/stat"',
    );

    const commandStubs = String.raw`
sleep() { :; }
kill() { printf 'kill %s %s\n' "$1" "$2" >> "$GPON_TEST_EVENTS"; }
ubus() {
  if [ "$1" = -t ]; then shift 2; fi
  case "$2:$3" in
    'network.interface:down') printf 'ubus-down\n' >> "$GPON_TEST_EVENTS" ;;
    'network.interface.wan:status') printf '%s\n' '{}' ;;
    *) return 1 ;;
  esac
}
jsonfilter() {
  case "$2" in
    '@.up'|'@.pending') printf 'false\n' ;;
    '@.device') printf 'eth5\n' ;;
    *) return 1 ;;
  esac
}
pidof() { return 1; }
ip() {
  if [ "$1" = link ] && [ "$2" = show ]; then
    printf '2: eth5: <UP>\n'
  fi
  return 0
}
cat() { printf '1\n'; }
uci() { printf '0\n'; }
`;
    const execution = spawnSync('/bin/sh', ['-c', `${commandStubs}\n${redirectedScript}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GPON_TEST_CLAIM_PATH: claimPath,
        GPON_TEST_EVENTS: eventsPath,
        GPON_TEST_LOCK_PATH: lockPath,
        GPON_TEST_PROC_ROOT: procRoot,
      },
      timeout: 5_000,
    });
    const events = await readFile(eventsPath, 'utf8');
    return { events, execution };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('stable O5 requires two samples spanning at least thirty seconds', () => {
  assert.equal(isStableO5Sequence({ consecutiveSamples: 1, elapsedMs: 30_000 }), false);
  assert.equal(isStableO5Sequence({ consecutiveSamples: 2, elapsedMs: 29_999 }), false);
  assert.equal(isStableO5Sequence({ consecutiveSamples: 2, elapsedMs: 30_000 }), true);
});

test('Router preflight accepts only its structured terminal result', async () => {
  const fake = fakeSsh([
    'ROUTER_PREFLIGHT=ready\nROUTER_PREFLIGHT_REASON=ready\n===ROUTER_PREFLIGHT_COMPLETE===\n',
  ]);
  const result = await runRouterPreflight({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.deepEqual(result, { gate: 'ready', reason: 'ready' });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].args.includes('-O'), true);
  const preflightScript = remoteScript(fake.calls[1]);
  assert.match(preflightScript, /wan_pending=.*jsonfilter -e '@\.pending'/);
  assert.match(preflightScript, /reason=wan_pending/);
  assert.match(preflightScript, /gpon-router-consumer\.lock/);
});

test('Router preflight reports an external in-flight WAN as pending', async () => {
  const fake = fakeSsh([
    'ROUTER_PREFLIGHT=blocked\nROUTER_PREFLIGHT_REASON=wan_pending\n===ROUTER_PREFLIGHT_COMPLETE===\n',
  ]);
  const result = await runRouterPreflight({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.deepEqual(result, { gate: 'blocked', reason: 'wan_pending' });
});

test('Router scripts bypass a Dropbear command-length ceiling through stdin', async () => {
  const calls = [];
  const outputs = [probeOutput(), commitOutput()];
  const executeFile = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('-O')) return { stdout: 'Master running\n', stderr: '' };
    const hostIndex = args.indexOf('root@router-b.local');
    const remoteCommand = args.slice(hostIndex + 1).join(' ');
    if (Buffer.byteLength(remoteCommand) > 9_000) {
      throw new Error('simulated Dropbear remote command ceiling');
    }
    return { stdout: outputs.shift() ?? '', stderr: '' };
  };

  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile,
  });

  assert.equal(result.gate, 'ready');
  assert.equal(result.lock, 'committed');
  assert.equal(calls.length, 4);
  const probeScript = remoteScript(calls[1]);
  assert.ok(Buffer.byteLength(probeScript) > 9_000);
  assert.match(probeScript, /connectivitycheck\.gstatic\.com\/generate_204/);
  assert.match(probeScript, /captive\.apple\.com\/hotspot-detect\.html/);
  assert.ok(
    probeScript.indexOf('connectivitycheck.gstatic.com/generate_204')
      < probeScript.indexOf('nc -w 5'),
  );
  assert.ok(Buffer.byteLength(remoteScript(calls[3])) > 1_024);
});

test('successful Router probe uses one ubus up and leaves the verified WAN up', async () => {
  const fake = fakeSsh([probeOutput(), commitOutput()]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.deepEqual(result, {
    gate: 'ready',
    precheck: 'ready',
    ifupOk: true,
    pado: 'confirmed_by_session',
    wanIpv4: true,
    dns: true,
    http: true,
    route: true,
    rollback: 'not_required',
    lock: 'committed',
    reason: 'subscriber_service_ready',
    commit: {
      gate: 'ready',
      reason: 'router_commit_verified',
    },
  });
  const probeScript = remoteScript(fake.calls[1]);
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', probeScript]).status, 0);
  assert.equal(
    probeScript.match(/ubus call network\.interface up '\{ "interface" : "wan" \}'/g)?.length,
    1,
  );
  assert.match(probeScript, /trap cleanup_on_exit EXIT/);
  assert.match(probeScript, /trap cleanup_on_signal HUP INT TERM/);
  assert.match(probeScript, /nc -w 5 "\$http_ip" 80/);
  assert.match(
    probeScript,
    /HTTP\/1\\\.\[01\].*\[1-5\]\[0-9\]\[0-9\]/,
    'any valid HTTP status must count as transport reachability',
  );
  assert.match(probeScript, /set -C; printf '%s\\n' "\$lock_token:precheck:\$lock_owner_pid" > "\$lock_path"/);
  assert.match(probeScript, /mkdir "\$claim_path\/probe\.\$lock_owner_pid\.\$lock_owner_starttime"/);
  assert.ok(probeScript.indexOf('mkdir "$claim_path"') < probeScript.indexOf('"$lock_token:precheck:$lock_owner_pid"'));
  assert.match(probeScript, /claim_path\/cancel/);
  assert.match(
    probeScript,
    /sleep 30[\s\S]*kill -TERM "\$mutator_pid"[\s\S]*kill -TERM "\$lock_owner_pid"[\s\S]*sleep 20[\s\S]*kill -KILL "\$mutator_pid"[\s\S]*kill -KILL "\$lock_owner_pid"/,
  );
  const watchdogArmedAt = probeScript.indexOf('watchdog_pid=$!');
  assert.notEqual(watchdogArmedAt, -1);
  assert.ok(watchdogArmedAt < probeScript.indexOf('mkdir "$mutator_go"', watchdogArmedAt));
  assert.ok(
    probeScript.indexOf('mkdir "$claim_path/mutator.$mutator_pid.$mutator_starttime"')
      < probeScript.indexOf('mkdir "$mutator_go"'),
  );
  assert.ok(probeScript.indexOf('rollback_wan\n    cleanup_needed=0') < probeScript.indexOf('kill "$watchdog_pid"'));
  assert.match(probeScript, /\[ "\$ifup_ok" = true \]/);
  assert.match(probeScript, /\[ "\$wan_up" = false \]/);
  assert.match(probeScript, /elif \[ "\$wan_pending" != false \]; then\n    precheck=wan_pending/);
  assert.match(probeScript, /current_lock_value.*"\$lock_token:precheck:\$lock_owner_pid"/s);
  assert.match(probeScript, /"\$lock_token:precheck:\$lock_owner_pid"/);
  assert.match(probeScript, /mark_lock_mutating/);
  assert.match(probeScript, /owns_lock_phase mutating && retain_lock/);
  assert.match(probeScript, /sleep 5[\s\S]*ip link set eth5 up[\s\S]*sleep 5/);
  assert.ok(probeScript.indexOf('set -C') < probeScript.indexOf('precheck=wan_already_up'));
  assert.ok(
    probeScript.indexOf('precheck=wan_already_up')
      < probeScript.indexOf('exec ubus call network.interface up'),
  );
  const commitScript = remoteScript(fake.calls[3]);
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', commitScript]).status, 0);
  assert.match(commitScript, /"\$lock_owner_phase" = mutating/);
  assert.match(commitScript, /"\$claim_pid" = "\$lock_owner_pid"/);
  assert.match(commitScript, /"\$mutator_claim_count" -eq 1/);
  assert.match(commitScript, /! process_identity_alive "\$mutator_pid" "\$mutator_starttime"/);
  assert.match(commitScript, /! -e "\$claim_path\/cancel"/);
  assert.match(commitScript, /"\$lock_token:committed:\$lock_owner_pid"/);
  assert.equal(
    commitScript.match(/lock_token='([0-9a-f-]+)'/)?.[1],
    probeScript.match(/lock_token='([0-9a-f-]+)'/)?.[1],
  );
  assert.equal(fake.calls.length, 4);
});

test('probe captures the gated ubus mutator identity before watchdog cleanup can run', async () => {
  const fake = fakeSsh([probeOutput(), commitOutput()]);
  await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  const probeScript = remoteScript(fake.calls[1]);
  const gateWait = probeScript.indexOf('while [ ! -d "$mutator_go" ]; do');
  const mutatorExec = probeScript.indexOf(
    'exec ubus call network.interface up \'{ "interface" : "wan" }\'',
    gateWait,
  );
  const capturePid = probeScript.indexOf('mutator_pid=$!', mutatorExec);
  const captureStarttime = probeScript.indexOf(
    'mutator_starttime=$(process_starttime "$mutator_pid")',
    capturePid,
  );
  const claimIdentity = probeScript.indexOf(
    'mkdir "$claim_path/mutator.$mutator_pid.$mutator_starttime"',
    captureStarttime,
  );
  const watchdogCancel = probeScript.indexOf('mkdir "$claim_path/cancel"', claimIdentity);
  const watchdogArmed = probeScript.indexOf('watchdog_pid=$!', watchdogCancel);
  const openGate = probeScript.indexOf('mkdir "$mutator_go"', watchdogArmed);

  assert.deepEqual(
    [
      gateWait,
      mutatorExec,
      capturePid,
      captureStarttime,
      claimIdentity,
      watchdogCancel,
      watchdogArmed,
      openGate,
    ].map(position => position >= 0),
    Array(8).fill(true),
  );
  assert.ok(gateWait < mutatorExec);
  assert.ok(mutatorExec < capturePid);
  assert.ok(capturePid < captureStarttime);
  assert.ok(captureStarttime < claimIdentity);
  assert.ok(claimIdentity < watchdogCancel);
  assert.ok(watchdogCancel < watchdogArmed);
  assert.ok(watchdogArmed < openGate);
  assert.match(
    probeScript,
    /cleanup_on_exit\(\) \{[\s\S]*mkdir "\$claim_path\/cancel"[\s\S]*stop_mutator[\s\S]*rollback_wan/,
  );
  assert.match(
    probeScript,
    /if process_identity_alive "\$mutator_pid" "\$mutator_starttime"; then[\s\S]*kill -TERM "\$mutator_pid"/,
  );
});

test('rollback cannot become ready while the exact claimed mutator identity is live', async () => {
  const fake = fakeSsh([rollbackOutput()]);
  await runRouterRollback({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    ownershipToken: OWNERSHIP_TOKEN,
    executeFile: fake.executeFile,
  });
  const rollbackScript = remoteScript(fake.calls[1]);

  const liveIdentity = await runRollbackIdentityHarness(rollbackScript, {
    claimedStarttime: '20202',
    observedStarttime: '20202',
  });
  assert.equal(liveIdentity.execution.status, 0, liveIdentity.execution.stderr);
  assert.match(liveIdentity.execution.stdout, /^ROLLBACK=blocked$/m);
  assert.match(liveIdentity.events, /^kill -TERM 410002$/m);
  assert.doesNotMatch(liveIdentity.events, /^ubus-down$/m);

  const staleIdentity = await runRollbackIdentityHarness(rollbackScript, {
    claimedStarttime: '20202',
    observedStarttime: '20203',
  });
  assert.equal(staleIdentity.execution.status, 0, staleIdentity.execution.stderr);
  assert.match(staleIdentity.execution.stdout, /^ROLLBACK=ready$/m);
  assert.match(staleIdentity.events, /^ubus-down$/m);
});

test('signal after a ready probe rolls back before committing success', async () => {
  const controller = new AbortController();
  const calls = [];
  const executeFile = async (_file, args, options) => {
    calls.push({ args, options });
    if (args.includes('-O')) return { stdout: '', stderr: '' };
    if (options.input.includes('ROUTER_CONSUMER_COMPLETE')) {
      controller.abort();
      return { stdout: probeOutput(), stderr: '' };
    }
    return { stdout: rollbackOutput(), stderr: '' };
  };
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile,
    signal: controller.signal,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.reason, 'router_probe_aborted');
  assert.equal(result.rollback, 'ready');
  assert.equal(result.lock, 'released');
  assert.equal(calls.length, 4);
  assert.equal(calls.some(call => call.options.input?.includes('ROUTER_COMMIT_COMPLETE')), false);
});

test('an incomplete success commit rolls back the retained mutation token', async () => {
  const fake = fakeSsh([
    probeOutput(),
    'unstructured commit output\n',
    rollbackOutput(),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.reason, 'router_commit_incomplete');
  assert.equal(result.rollback, 'ready');
  assert.equal(result.lock, 'released');
  assert.equal(fake.calls.length, 6);
  assert.match(remoteScript(fake.calls[5]), /precheck\|mutating\|cleanup\|committed/);
});

test('post-PADO validation failure preserves evidence and requires rollback', async () => {
  const fake = fakeSsh([
    probeOutput({
      ROUTER_CONSUMER: 'blocked',
      DNS: 'false',
      HTTP: 'false',
      ROUTE: 'false',
      ROLLBACK: 'ready',
      LOCK: 'released',
    }),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.pado, 'confirmed_by_session');
  assert.equal(result.wanIpv4, true);
  assert.equal(result.rollback, 'ready');
  assert.equal(fake.calls.length, 2);
});

test('an exact attempt-scoped no-PADO result is distinct from unknown', async () => {
  const fake = fakeSsh([
    probeOutput({
      ROUTER_CONSUMER: 'blocked',
      PADO: 'no_pado',
      WAN_IPV4: 'false',
      DNS: 'false',
      HTTP: 'false',
      ROUTE: 'false',
      ROLLBACK: 'ready',
      LOCK: 'released',
    }),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.pado, 'no_pado');
  assert.equal(result.rollback, 'ready');
});

test('owned probe failure retries a blocked rollback once without a second WAN-up mutation', async () => {
  const fake = fakeSsh([
    probeOutput({
      ROUTER_CONSUMER: 'blocked',
      PADO: 'no_pado',
      WAN_IPV4: 'false',
      DNS: 'false',
      HTTP: 'false',
      ROUTE: 'false',
      ROLLBACK: 'blocked',
      LOCK: 'retained',
    }),
    rollbackOutput(),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.pado, 'no_pado');
  assert.equal(result.rollback, 'ready');
  assert.equal(result.cleanupRetry.gate, 'ready');
  assert.equal(result.cleanupRetry.reason, 'router_rollback_verified');
  assert.equal(fake.calls.length, 4);
  const cleanupScript = remoteScript(fake.calls[3]);
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', cleanupScript]).status, 0);
  const probeToken = remoteScript(fake.calls[1]).match(/lock_token='([0-9a-f-]+)'/)?.[1];
  const cleanupToken = cleanupScript.match(/lock_token='([0-9a-f-]+)'/)?.[1];
  assert.ok(probeToken);
  assert.equal(cleanupToken, probeToken);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(probeToken));
  assert.doesNotMatch(cleanupScript, /network\.interface up/);
  assert.match(cleanupScript, /ubus -t 3 call network\.interface down/);
  assert.match(cleanupScript, /cleanup_authorized=false/);
  assert.match(cleanupScript, /precheck\|mutating\|cleanup\|committed/);
  assert.match(cleanupScript, /mkdir "\$claim_path\/cancel"/);
  assert.ok(
    cleanupScript.indexOf('mkdir "$claim_path/cancel"')
      < cleanupScript.indexOf('ubus -t 3 call network.interface down'),
  );
  assert.match(cleanupScript, /process_identity_alive "\$claim_pid" "\$claim_starttime"/);
  assert.match(cleanupScript, /kill -TERM "\$mutator_pid"/);
  assert.match(cleanupScript, /kill -KILL "\$mutator_pid"/);
  assert.ok(
    cleanupScript.indexOf('stop_claimed_mutator')
      < cleanupScript.indexOf('ubus -t 3 call network.interface down'),
  );
  assert.match(cleanupScript, /sleep 5[\s\S]*ip link set eth5 up[\s\S]*sleep 5/);
  assert.equal(fake.calls[3].options.timeout, ROUTER_ROLLBACK_TIMEOUT_MS);
  assert.equal(fake.calls[1].options.timeout, ROUTER_PROBE_TIMEOUT_MS);
  assert.ok(ROUTER_PROBE_TIMEOUT_MS > (
    ROUTER_PROBE_WATCHDOG_SEC + ROUTER_PROBE_KILL_GRACE_SEC
  ) * 1_000);
  assert.ok(ROUTER_CLEANUP_OWNER_WAIT_SEC > (
    ROUTER_PROBE_WATCHDOG_SEC + ROUTER_PROBE_KILL_GRACE_SEC + (2 * ROUTER_ROLLBACK_SETTLE_SEC)
  ));
  assert.ok(ROUTER_ROLLBACK_TIMEOUT_MS >= (
    ROUTER_CONSUMER_TIMEOUT_SEC + (2 * ROUTER_ROLLBACK_SETTLE_SEC) + 5
  ) * 1_000);
});

test('owned probe failure bounds a second blocked rollback without a third attempt', async () => {
  const fake = fakeSsh([
    probeOutput({
      ROUTER_CONSUMER: 'blocked',
      PADO: 'no_pado',
      WAN_IPV4: 'false',
      DNS: 'false',
      HTTP: 'false',
      ROUTE: 'false',
      ROLLBACK: 'blocked',
      LOCK: 'retained',
    }),
    rollbackOutput({
      ROLLBACK: 'blocked',
      UBUS: 'failed',
      WAN_UP: 'unknown',
      PPPD: 'present',
    }),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.pado, 'no_pado');
  assert.equal(result.rollback, 'blocked');
  assert.equal(result.cleanupRetry.gate, 'blocked');
  assert.equal(result.cleanupRetry.reason, 'router_rollback_failed');
  assert.equal(fake.calls.length, 4);
});

test('missing probe marker exposes no raw output and runs cleanup-only', async () => {
  const fake = fakeSsh([
    'unstructured private remote output\n',
    rollbackOutput(),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.precheck, 'unknown');
  assert.equal(result.rollback, 'ready');
  assert.equal(result.lock, 'released');
  assert.equal(result.reason, 'router_probe_incomplete');
  assert.equal(result.cleanupRetry.gate, 'ready');
  assert.equal(fake.calls.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /private remote output/);
  const cleanupScript = remoteScript(fake.calls[3]);
  assert.doesNotMatch(cleanupScript, /network\.interface up/);
  assert.match(cleanupScript, /cleanup_authorized=false/);
  assert.match(cleanupScript, /expected_lock_value="\$lock_token:precheck:\$current_lock_pid"/);
  assert.match(cleanupScript, /\[ "\$wan_up" = false \]/);
  const authorizationGate = cleanupScript.indexOf('if [ "$cleanup_authorized" = true ]; then');
  const rollbackCommand = cleanupScript.indexOf('ubus -t 3 call network.interface down');
  assert.ok(authorizationGate >= 0 && authorizationGate < rollbackCommand);
  assert.equal(cleanupScript.match(/ubus -t 3 call network\.interface down/g)?.length, 1);
});

test('WAN-up command failure cannot adopt an externally ready WAN session', async () => {
  const fake = fakeSsh([
    probeOutput({ IFUP_OK: 'false' }),
    rollbackOutput(),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.ifupOk, false);
  assert.equal(result.reason, 'router_probe_incomplete');
  assert.equal(result.rollback, 'ready');
  assert.equal(fake.calls.length, 4);
});

test('already-up inline precheck blocks without tearing down the external session', async () => {
  const fake = fakeSsh([probeOutput({
    ROUTER_CONSUMER: 'blocked',
    PRECHECK: 'wan_already_up',
    IFUP_OK: 'false',
    PADO: 'unknown',
    WAN_IPV4: 'false',
    DNS: 'false',
    HTTP: 'false',
    ROUTE: 'false',
    ROLLBACK: 'not_required',
    LOCK: 'released',
  })]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.precheck, 'wan_already_up');
  assert.equal(result.rollback, 'not_required');
  assert.equal(fake.calls.length, 2);
});

test('an unreleased precheck lock uses token cleanup without authorizing WAN down', async () => {
  const fake = fakeSsh([
    probeOutput({
      ROUTER_CONSUMER: 'blocked',
      PRECHECK: 'wan_already_up',
      IFUP_OK: 'false',
      PADO: 'unknown',
      WAN_IPV4: 'false',
      DNS: 'false',
      HTTP: 'false',
      ROUTE: 'false',
      ROLLBACK: 'not_required',
      LOCK: 'retained',
    }),
    rollbackOutput({
      ROLLBACK: 'blocked',
      WAN_UP: 'true',
      WAN_PENDING: 'false',
      PPPD: 'present',
    }),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.precheck, 'unknown');
  assert.equal(result.rollback, 'blocked');
  assert.equal(fake.calls.length, 4);
  const cleanupScript = remoteScript(fake.calls[3]);
  assert.match(cleanupScript, /expected_lock_value="\$lock_token:precheck:\$current_lock_pid"/);
  assert.ok(
    cleanupScript.indexOf('cleanup_authorized=false')
      < cleanupScript.indexOf('ubus -t 3 call network.interface down'),
  );
});

test('an unreleased remote lock cannot produce a ready result', async () => {
  const fake = fakeSsh([
    probeOutput({ LOCK: 'release_failed' }),
    rollbackOutput(),
  ]);
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: fake.executeFile,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.reason, 'router_probe_incomplete');
  assert.equal(result.rollback, 'ready');
});

test('rollback requires successful ubus with exact false WAN state', async () => {
  const failedUbus = fakeSsh([rollbackOutput({
    ROLLBACK: 'blocked',
    UBUS: 'failed',
    WAN_UP: 'unknown',
  })]);
  const failedResult = await runRouterRollback({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    ownershipToken: OWNERSHIP_TOKEN,
    executeFile: failedUbus.executeFile,
  });
  assert.equal(failedResult.gate, 'blocked');
  assert.equal(failedResult.ubus, 'failed');
  assert.equal(failedResult.wanUp, 'unknown');
  assert.equal(failedResult.reason, 'router_rollback_failed');

  const inconsistent = fakeSsh([rollbackOutput({ WAN_UP: 'unknown' })]);
  const inconsistentResult = await runRouterRollback({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    ownershipToken: OWNERSHIP_TOKEN,
    executeFile: inconsistent.executeFile,
  });
  assert.deepEqual(inconsistentResult, {
    gate: 'blocked',
    ubus: 'unknown',
    wanUp: 'unknown',
    wanPending: 'unknown',
    wanDevice: 'unknown',
    pppd: 'unknown',
    eth5Up: 'unknown',
    eth5Carrier: 'unknown',
    stickReachable: 'unknown',
    auto0: 'unknown',
    reason: 'router_rollback_incomplete',
  });

  const unowned = fakeSsh([]);
  const unownedResult = await runRouterRollback({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile: unowned.executeFile,
  });
  assert.equal(unownedResult.gate, 'blocked');
  assert.equal(unownedResult.reason, 'router_rollback_ownership_required');
  assert.equal(unowned.calls.length, 0);
});

test('AbortSignal applies only to the probe and triggers a fresh rollback', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const executeFile = async (_file, args, options) => {
    calls.push({ args, options });
    if (args.includes('-O')) return { stdout: '', stderr: '' };
    if (options.signal === controller.signal) throw new Error('probe aborted');
    return { stdout: rollbackOutput(), stderr: '' };
  };
  const result = await runRouterWanProbe({
    controlSocket: '/tmp/router.sock',
    host: 'root@router-b.local',
    executeFile,
    signal: controller.signal,
  });
  assert.equal(result.gate, 'blocked');
  assert.equal(result.reason, 'router_probe_aborted');
  assert.equal(result.rollback, 'ready');
  assert.equal(calls.length, 4);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[0].options.signal, undefined);
  assert.equal(calls[2].options.signal, undefined);
  assert.equal(calls[3].options.signal, undefined);
});

test('Router attempt marker is durable, mode 0600 and consumed at most once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpon-router-attempt-test-'));
  const attemptPath = join(directory, 'cutover.done.router-attempt');
  const fsyncTargets = [];
  const fileSystem = {
    closeSync,
    fchmodSync,
    fstatSync,
    fsyncSync(descriptor) {
      fsyncTargets.push(fstatSync(descriptor).isDirectory() ? 'directory' : 'file');
      fsyncSync(descriptor);
    },
    openSync,
    writeSync,
  };
  consumeRouterAttempt(
    attemptPath,
    { runId: 'test-run', claimedAt: 'test-time' },
    { fileSystem },
  );
  assert.deepEqual(fsyncTargets, ['file', 'directory']);
  assert.equal((await stat(attemptPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(attemptPath, 'utf8')), {
    runId: 'test-run',
    claimedAt: 'test-time',
  });
  assert.throws(
    () => consumeRouterAttempt(attemptPath, { runId: 'second-run' }),
    error => error.code === 'router_attempt_already_consumed',
  );
  assert.throws(
    () => consumeRouterAttempt('relative.router-attempt', { runId: 'relative-run' }),
    error => error.code === 'router_attempt_path_not_absolute',
  );
});
