#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  GPON_CONSUMER_MES,
  isQualifiedOffFiberPrecut,
  parseGponConsumerSnapshot,
  parseGponOnuState,
  shouldCaptureConsumerSnapshot,
} from '../lib/gpon-consumer-gate.js';
import {
  consumeRouterAttempt,
  isStableO5Sequence,
  REQUIRED_MANUAL_VID,
  runRouterPreflight,
  runRouterWanProbe,
} from '../lib/gpon-router-consumer.js';
import { withRetry } from '../lib/retry.js';

const execFileAsync = promisify(execFile);
const MIN_INTERVAL_SEC = 30;
const MAX_NODE_TIMER_MS = 2_147_483_647;

const HELP = `gpon_cutover_monitor.mjs - ODI GPON cutover monitor

Purpose:
  Poll ODI state and record evidence without changing flash, rebooting or
  resetting the OLT. The default mode is read-only. One explicit OpenWrt-router
  opt-in can run the existing UCI WAN consumer once after every prerequisite
  gate is fresh and ready. In opted-in mode, move fibre only while this process
  is still running and its durable marker says status=armed_for_fiber_move; an
  optical-state return to O1 invalidates that marker and requires a new run.

Usage:
  node odi-scripts/gpon_cutover_monitor.mjs [options]

Options:
  --endpoint URL       Exact HTTP origin of the ODI bridge
                       (default: http://127.0.0.1:18080)
  --interval-sec N     Poll interval in seconds (default: 300)
  --duration-sec N     Total runtime in seconds (default: 28800)
  --output PATH        JSONL evidence file
                       (default: /tmp/gpon-stick-watch.jsonl)
  --done-marker PATH   Completion marker
                       (default: /tmp/gpon-stick-watch.done)
  --stick-control-socket PATH
                       Existing SSH ControlMaster socket for the stick. No
                       password is accepted or stored.
  --stick-host HOST    SSH destination used with that socket
                       (default: admin@stick.local)
  --status-via-stick-ssh
                       Read O-state with "diag gpon get onu-state" over the
                       existing socket instead of the HTTP status page
  --expected-manual-vid VID
                       Fail the local-ingress gate unless flash and runtime
                       both use this exact Manual PVID (1..4094), priority is
                       present and consistent, and omci_app consumes both
  --snapshot-on-o5     Capture ME84/171, T-CONT and GEM evidence at O5; retry
                       at the safe poll interval until prerequisite gates are
                       ready; does not stop the monitor and requires the socket.
                       This is prerequisite evidence, not Internet success.
  --snapshot-timeout-sec N
                       Completion-marker deadline for a read-only OMCI
                       snapshot (default: 5)
  --router-consumer-on-ready
                       Explicitly allow one fixed 15-second netifd WAN probe
                       only after this invocation first qualifies an off-fibre
                       O1 pre-cut, then sees stable O5 plus fresh OMCI/local
                       ingress closure. The tracked mutator is the exact
                       netifd WAN-up ubus call. Requires --status-via-stick-ssh.
  --router-control-socket PATH
                       Existing router SSH ControlMaster socket; no password
                       is accepted, read or stored
  --router-host HOST   Explicit SSH destination for that existing Router master
  --once               Poll exactly once. With a ControlMaster socket, capture
                       one read-only snapshot of the current state.
  --help               Show this help

Examples:
  node odi-scripts/gpon_cutover_monitor.mjs --once
  node odi-scripts/gpon_cutover_monitor.mjs --interval-sec 30 \\
    --duration-sec 120 --snapshot-on-o5 \\
    --stick-control-socket /tmp/odi-stick-master.sock \\
    --output /tmp/gpon-cutover.jsonl

Exit codes:
  0  Monitor completed, or opted-in subscriber service reached full closure
  1  Runtime/network error or opted-in consumer did not reach full closure
  2  Invalid command-line usage
`;

function usageError(message) {
  console.error(`error: ${message}`);
  console.error('Run with --help for usage.');
  process.exit(2);
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) usageError(`${flag} must be > 0`);
  return number;
}

function parseArgs(argv) {
  const options = {
    endpoint: 'http://127.0.0.1:18080',
    intervalSec: 300,
    durationSec: 28_800,
    output: '/tmp/gpon-stick-watch.jsonl',
    doneMarker: '/tmp/gpon-stick-watch.done',
    stickControlSocket: null,
    stickHost: 'admin@stick.local',
    statusViaStickSsh: false,
    expectedManualVid: null,
    snapshotOnO5: false,
    snapshotTimeoutSec: 5,
    routerConsumerOnReady: false,
    routerControlSocket: null,
    routerHost: null,
    once: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (flag === '--stop-on-o5') {
      usageError('--stop-on-o5 is unsafe: O5 is not subscriber-service closure; use --snapshot-on-o5');
    }
    if (flag === '--snapshot-on-o5') options.snapshotOnO5 = true;
    else if (flag === '--router-consumer-on-ready') options.routerConsumerOnReady = true;
    else if (flag === '--status-via-stick-ssh') options.statusViaStickSsh = true;
    else if (flag === '--once') options.once = true;
    else if (flag === '--endpoint') options.endpoint = argv[++index];
    else if (flag === '--interval-sec') options.intervalSec = positiveNumber(argv[++index], flag);
    else if (flag === '--duration-sec') options.durationSec = positiveNumber(argv[++index], flag);
    else if (flag === '--snapshot-timeout-sec') {
      options.snapshotTimeoutSec = positiveNumber(argv[++index], flag);
    }
    else if (flag === '--output') options.output = argv[++index];
    else if (flag === '--done-marker') options.doneMarker = argv[++index];
    else if (flag === '--stick-control-socket') options.stickControlSocket = argv[++index];
    else if (flag === '--stick-host') options.stickHost = argv[++index];
    else if (flag === '--router-control-socket') options.routerControlSocket = argv[++index];
    else if (flag === '--router-host') options.routerHost = argv[++index];
    else if (flag === '--expected-manual-vid') {
      const value = argv[++index];
      if (!/^\d+$/.test(value ?? '')) usageError(`${flag} must be an integer from 1 to 4094`);
      options.expectedManualVid = Number.parseInt(value, 10);
      if (options.expectedManualVid < 1 || options.expectedManualVid > 4094) {
        usageError(`${flag} must be an integer from 1 to 4094`);
      }
    }
    else usageError(`unknown option: ${flag}`);

    if (
      options.endpoint === undefined
      || options.output === undefined
      || options.doneMarker === undefined
      || options.stickControlSocket === undefined
      || options.stickHost === undefined
      || options.routerControlSocket === undefined
      || options.routerHost === undefined
      || options.snapshotTimeoutSec === undefined
    ) {
      usageError(`${flag} requires a value`);
    }
  }

  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol)) usageError('--endpoint must use http or https');
  if (endpoint.username || endpoint.password) usageError('--endpoint must not contain credentials');
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    usageError('--endpoint must be an exact origin without a path, query, or fragment');
  }
  if (!options.once && options.intervalSec < MIN_INTERVAL_SEC) {
    usageError(`--interval-sec must be >= ${MIN_INTERVAL_SEC} unless --once is used`);
  }
  if (options.intervalSec * 1_000 > MAX_NODE_TIMER_MS) {
    usageError('--interval-sec exceeds the safe Node timer range');
  }
  if (options.snapshotTimeoutSec * 1_000 > MAX_NODE_TIMER_MS) {
    usageError('--snapshot-timeout-sec exceeds the safe Node timer range');
  }
  if (options.snapshotOnO5 && !options.stickControlSocket) {
    usageError('--snapshot-on-o5 requires --stick-control-socket');
  }
  if (options.statusViaStickSsh && !options.stickControlSocket) {
    usageError('--status-via-stick-ssh requires --stick-control-socket');
  }
  if (options.expectedManualVid !== null && !options.stickControlSocket) {
    usageError('--expected-manual-vid requires --stick-control-socket');
  }
  if (options.routerConsumerOnReady) {
    if (options.once) usageError('--router-consumer-on-ready cannot be used with --once');
    if (!options.routerControlSocket) {
      usageError('--router-consumer-on-ready requires --router-control-socket');
    }
    if (!options.routerHost) usageError('--router-consumer-on-ready requires --router-host');
    if (!options.stickControlSocket) {
      usageError('--router-consumer-on-ready requires --stick-control-socket');
    }
    if (!options.snapshotOnO5) usageError('--router-consumer-on-ready requires --snapshot-on-o5');
    if (!options.statusViaStickSsh) {
      usageError('--router-consumer-on-ready requires --status-via-stick-ssh');
    }
    if (options.expectedManualVid !== REQUIRED_MANUAL_VID) {
      usageError(`--router-consumer-on-ready requires --expected-manual-vid ${REQUIRED_MANUAL_VID}`);
    }
  } else if (options.routerControlSocket || options.routerHost) {
    usageError('Router options require explicit --router-consumer-on-ready');
  }
  if (options.stickHost.startsWith('-') || !/^[A-Za-z0-9_.:@%+-]+$/.test(options.stickHost)) {
    usageError('--stick-host must be a plain SSH destination without whitespace or options');
  }
  if (
    options.routerHost !== null
    && (options.routerHost.startsWith('-') || !/^[A-Za-z0-9_.:@%+-]+$/.test(options.routerHost))
  ) {
    usageError('--router-host must be a plain SSH destination without whitespace or options');
  }
  const outputPath = resolve(options.output);
  const doneMarkerPath = resolve(options.doneMarker);
  const leasePath = `${doneMarkerPath}.lock`;
  const routerAttemptPath = `${doneMarkerPath}.router-attempt`;
  if (
    outputPath === doneMarkerPath
    || outputPath === leasePath
    || outputPath === routerAttemptPath
  ) {
    usageError('--output must differ from --done-marker and its state files');
  }
  try {
    const outputStat = statSync(outputPath);
    const doneStat = statSync(doneMarkerPath);
    if (outputStat.dev === doneStat.dev && outputStat.ino === doneStat.ino) {
      usageError('--output and --done-marker must not be hard links to the same file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (options.routerConsumerOnReady) {
    let canonicalDoneMarkerPath;
    try {
      canonicalDoneMarkerPath = resolve(
        realpathSync(dirname(doneMarkerPath)),
        basename(doneMarkerPath),
      );
    } catch {
      usageError('--router-consumer-on-ready requires an existing persistent done-marker directory');
    }
    const temporaryRoots = [...new Set(['/tmp', '/private/tmp', tmpdir()].map(path => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    }))];
    const markerUsesTemporaryStorage = temporaryRoots.some(root => (
      canonicalDoneMarkerPath === root || canonicalDoneMarkerPath.startsWith(`${root}/`)
    ));
    if (markerUsesTemporaryStorage) {
      usageError(
        '--router-consumer-on-ready requires a persistent --done-marker outside temporary storage',
      );
    }
    try {
      lstatSync(routerAttemptPath);
      usageError('Router attempt marker already exists; refusing a second consumer attempt');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const outputStat = statSync(outputPath);
      const attemptStat = statSync(routerAttemptPath);
      if (outputStat.dev === attemptStat.dev && outputStat.ino === attemptStat.ino) {
        usageError('--output and the Router attempt marker must not be hard links');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  options.output = outputPath;
  options.doneMarker = doneMarkerPath;
  options.endpoint = endpoint.origin;
  return options;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCell(html, label) {
  const expression = new RegExp(
    `<b>\\s*${escapeRegExp(label)}\\s*</b>[\\s\\S]{0,180}?<td[^>]*>[\\s\\S]{0,80}?<font[^>]*>([^<]*)(?:</font>)?\\s*</td>`,
    'i',
  );
  return html.match(expression)?.[1]?.trim() ?? null;
}

function parseStatus(html) {
  return {
    onuState: extractCell(html, 'ONU State'),
    onuId: extractCell(html, 'ONU ID'),
    temperature: extractCell(html, 'Temperature'),
    voltage: extractCell(html, 'Voltage'),
    txPower: extractCell(html, 'Tx Power'),
    rxPower: extractCell(html, 'Rx Power'),
    biasCurrent: extractCell(html, 'Bias Current'),
  };
}

async function fetchHttpStatus(origin) {
  return withRetry(async () => {
    const response = await fetch(new URL('/status_pon.asp', origin), {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const status = parseStatus(html);
    if (!status.onuState) throw new Error('status page did not contain ONU State');
    return status;
  }, {
    retries: 2,
    baseDelay: 500,
    onRetry: (attempt, error, delay) => {
      console.error(`poll retry ${attempt}/2 in ${delay}ms: ${error.message}`);
    },
  });
}

async function fetchStickSshStatus(options) {
  assertExistingControlSocket(options.stickControlSocket);
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ssh', [
      '-S', options.stickControlSocket,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      options.stickHost,
      'diag gpon get onu-state',
    ], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new Error('stick SSH status command failed');
  }
  const onuState = parseGponOnuState(stdout);
  if (!onuState) throw new Error('diag output did not contain ONU state');
  return {
    onuState,
    onuId: null,
    temperature: null,
    voltage: null,
    txPower: null,
    rxPower: null,
    biasCurrent: null,
    statusSource: 'stick-ssh-diag',
  };
}

async function fetchStatus(options) {
  if (options.statusViaStickSsh) {
    return withRetry(() => fetchStickSshStatus(options), {
      retries: 2,
      baseDelay: 500,
      onRetry: (attempt, error, delay) => {
        console.error(`poll retry ${attempt}/2 in ${delay}ms: ${error.message}`);
      },
    });
  }
  return fetchHttpStatus(options.endpoint);
}

function assertExistingControlSocket(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error('SSH ControlMaster socket is unavailable');
  }
  if (!stat.isSocket()) throw new Error('SSH ControlMaster path is not a Unix socket');
}

async function captureConsumerSnapshot(options, { includeOmciMibs = true } = {}) {
  assertExistingControlSocket(options.stickControlSocket);
  const localVlanScript = [
    "printf '%s\\n' '===LOCAL_VLAN_FLASH==='",
    'flash get VLAN_CFG_TYPE 2>&1 || true',
    'flash get VLAN_MANU_MODE 2>&1 || true',
    'flash get VLAN_MANU_TAG_VID 2>&1 || true',
    'flash get VLAN_MANU_TAG_PRI 2>&1 || true',
    "printf '%s\\n' '===LOCAL_VLAN_MIB==='",
    "printf 'VLAN_CFG_TYPE='; mib get VLAN_CFG_TYPE 2>&1 || true",
    "printf 'VLAN_MANU_MODE='; mib get VLAN_MANU_MODE 2>&1 || true",
    "printf 'VLAN_MANU_TAG_VID='; mib get VLAN_MANU_TAG_VID 2>&1 || true",
    "printf 'VLAN_MANU_TAG_PRI='; mib get VLAN_MANU_TAG_PRI 2>&1 || true",
    "printf '%s\\n' '===LOCAL_VLAN_COMPLETE==='",
  ].join('; ');
  const consumerScript = [
    "printf '%s\\n' '===PROC==='",
    'cat /proc/uptime 2>&1 || true',
    "grep -E '^(MemTotal|MemFree|MemAvailable):' /proc/meminfo 2>&1 || true",
    "printf '%s\\n' '===OMCI_APP_CMDLINE==='",
    "for p in $(pidof omci_app 2>/dev/null); do tgid=$(sed -n 's/^Tgid:[[:space:]]*//p' /proc/$p/status 2>/dev/null); ppid=$(sed -n 's/^PPid:[[:space:]]*//p' /proc/$p/status 2>/dev/null); cmd=$(tr '\\000' '\\n' < /proc/$p/cmdline 2>/dev/null | awk 'BEGIN { printf \"omci_app\" } take { printf \" %s\", $0; take=0; next } /^-iot_(vt|vm|vid|pri)$/ { printf \" %s\", $0; take=1 } END { printf \"\\n\" }'); printf 'PID=%s TGID=%s PPID=%s CMDLINE=%s\\n' \"$p\" \"$tgid\" \"$ppid\" \"$cmd\"; done",
    ...(includeOmciMibs
      ? [
        `for class_id in ${GPON_CONSUMER_MES.join(' ')}; do printf '===ME:%s===\\n' "$class_id"; omcicli mib get "$class_id" 2>&1 || true; done`,
      ]
      : []),
    "printf '%s\\n' '===SNAPSHOT_COMPLETE==='",
  ].join('; ');
  const executeCompleteRemoteScript = async (script, completionMarker) => {
    const sshArgs = [
      '-S', options.stickControlSocket,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      options.stickHost,
      script,
    ];
    const requireCompletionMarker = result => {
      const lines = typeof result.stdout === 'string' ? result.stdout.split(/\r?\n/) : [];
      while (lines.at(-1)?.trim() === '') lines.pop();
      const markerCount = lines.filter(line => line.trim() === completionMarker).length;
      if (markerCount !== 1 || lines.at(-1)?.trim() !== completionMarker) {
        throw new Error(`remote snapshot incomplete: ${completionMarker} must be the unique terminal line`);
      }
      return {
        ...result,
        stdout: `${lines.slice(0, -1).join('\n')}\n`,
      };
    };
    try {
      const result = await execFileAsync('ssh', sshArgs, {
        timeout: options.snapshotTimeoutSec * 1_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return requireCompletionMarker(result);
    } catch (error) {
      if (typeof error.stdout !== 'string' || error.stdout.trim() === '') {
        throw new Error('remote snapshot command failed before structured output');
      }
      return requireCompletionMarker({ stdout: error.stdout, stderr: error.stderr ?? '' });
    }
  };
  const localVlan = await executeCompleteRemoteScript(
    localVlanScript,
    '===LOCAL_VLAN_COMPLETE===',
  );
  const consumer = await executeCompleteRemoteScript(
    consumerScript,
    '===SNAPSHOT_COMPLETE===',
  );
  if (includeOmciMibs) {
    const observedMes = [...consumer.stdout.matchAll(/^===ME:(\d+)===$/gm)]
      .map(match => Number.parseInt(match[1], 10));
    const exactExpectedMes = observedMes.length === GPON_CONSUMER_MES.length
      && observedMes.every((classId, index) => classId === GPON_CONSUMER_MES[index]);
    if (!exactExpectedMes) {
      throw new Error(
        `remote O5 snapshot incomplete: expected ME markers ${GPON_CONSUMER_MES.join(',')}; got ${observedMes.join(',') || 'none'}`,
      );
    }
  }
  const raw = `${localVlan.stdout}\n${consumer.stdout}`;
  return parseGponConsumerSnapshot(raw, {
    expectedManualVid: options.expectedManualVid,
    acquisitionValidated: true,
  });
}

const options = parseArgs(process.argv.slice(2));
const runId = randomUUID();
const runStartedAt = new Date().toISOString();
const startedAt = Date.now();
let stopping = false;
let samples = 0;
let errors = 0;
let lastState = null;
let lastSampleOk = false;
let o5Observed = false;
let snapshotTaken = false;
let o5OmciSnapshotTaken = false;
let stableO5SnapshotTaken = false;
let consecutiveO5Samples = 0;
let o5SequenceStartedAt = null;
let o5SequenceStartedMonotonic = null;
let o5SequenceElapsedMs = 0;
let lastO5SampleAt = null;
let o5Stable = false;
let lastOmciProvisioningGate = 'unknown';
let lastLocalIngressGate = 'unknown';
let routerPreflight = options.routerConsumerOnReady
  ? { gate: 'unknown', reason: 'not_checked' }
  : { gate: 'disabled', reason: 'not_requested' };
let startupRouterPreflightReady = false;
let routerConsumerAttempted = false;
let routerConsumerInFlight = false;
let routerProbeAbortController = null;
let routerConsumerResult = null;
let subscriberServiceGate = 'pending_router_consumer';
let offFiberPrecutGate = options.routerConsumerOnReady ? 'pending' : 'not_requested';
let offFiberPrecutQualifiedAt = null;
let offFiberPrecutQualifiedSample = null;
let offFiberPrecutSequenceTainted = false;
let pendingSignal = null;
let reason = 'duration_complete';
const runLeasePath = `${options.doneMarker}.lock`;
const routerAttemptPath = `${options.doneMarker}.router-attempt`;
let runLeaseDescriptor;

function requireSafeRegularTarget(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink target: ${path}`);
    if (!stat.isFile()) throw new Error(`refusing non-regular target: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeAllSync(descriptor, data) {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
  }
}

function readSecureRegularFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`refusing non-regular target: ${path}`);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function createRunLease() {
  const descriptor = openSync(
    runLeasePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const lease = `${JSON.stringify({ runId, runStartedAt, pid: process.pid })}\n`;
    fchmodSync(descriptor, 0o600);
    writeAllSync(descriptor, lease);
    fsyncSync(descriptor);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(runLeasePath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError.message;
    }
    throw error;
  }
}

function claimRunLease() {
  try {
    return createRunLease();
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`run lease already exists; refusing automatic recovery: ${runLeasePath}`);
    }
    throw error;
  }
}

function assertRunLeaseOwned() {
  const pathStat = lstatSync(runLeasePath);
  const descriptorStat = fstatSync(runLeaseDescriptor);
  if (!pathStat.isFile() || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new Error('run lease identity changed before completion');
  }
  const lease = JSON.parse(readSecureRegularFile(runLeasePath));
  if (lease.runId !== runId || lease.pid !== process.pid) {
    throw new Error('run lease ownership changed before completion');
  }
}

function releaseRunLease() {
  assertRunLeaseOwned();
  closeSync(runLeaseDescriptor);
  runLeaseDescriptor = undefined;
  unlinkSync(runLeasePath);
}

function reserveFreshRunTarget(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    return {
      descriptor,
      identity: fstatSync(descriptor),
      path,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      const identity = fstatSync(descriptor);
      closeSync(descriptor);
      try {
        const current = lstatSync(path);
        if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  }
}

function removeReservedRunTarget(reservation, error) {
  closeSync(reservation.descriptor);
  try {
    const current = lstatSync(reservation.path);
    if (current.dev === reservation.identity.dev && current.ino === reservation.identity.ino) {
      unlinkSync(reservation.path);
    }
  } catch (cleanupError) {
    if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError.message;
  }
}

function reserveFreshRunTargets() {
  const reservations = [];
  try {
    reservations.push(reserveFreshRunTarget(options.output));
    reservations.push(reserveFreshRunTarget(options.doneMarker));
    for (const reservation of reservations) closeSync(reservation.descriptor);
  } catch (error) {
    for (const reservation of reservations.reverse()) {
      removeReservedRunTarget(reservation, error);
    }
    if (error.code === 'EEXIST') {
      throw new Error('run output or done marker already exists; refusing evidence reuse');
    }
    throw error;
  }
}

function secureAppend(path, data) {
  requireSafeRegularTarget(path);
  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`refusing non-regular target: ${path}`);
    fchmodSync(descriptor, 0o600);
    writeAllSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function secureAtomicWrite(path, data) {
  requireSafeRegularTarget(path);
  const temporaryPath = `${path}.${process.pid}.${runId}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeAllSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError.message;
    }
    throw error;
  }
}

function writeRunMarker(status, extra = {}) {
  const marker = {
    runId,
    runStartedAt,
    status,
    ...extra,
  };
  secureAtomicWrite(options.doneMarker, `${JSON.stringify(marker)}\n`);
}

function invalidateArmedPrecut(invalidationReason) {
  if (offFiberPrecutGate !== 'ready') return;
  offFiberPrecutGate = 'invalidated';
  offFiberPrecutQualifiedAt = null;
  offFiberPrecutQualifiedSample = null;
  offFiberPrecutSequenceTainted = true;
  try {
    writeRunMarker('precut_invalidated', {
      startedAt: runStartedAt,
      pid: process.pid,
      samples,
      errors,
      reason: invalidationReason,
      offFiberPrecutGate,
      offFiberPrecutQualifiedAt,
      offFiberPrecutQualifiedSample,
      offFiberPrecutSequenceTainted,
      evidence: options.output,
    });
  } catch (error) {
    const fatalError = new Error(`fatal precut marker invalidation failure: ${error.message}`, {
      cause: error,
    });
    fatalError.fatalRunMarker = true;
    throw fatalError;
  }
}

function record(event) {
  const line = `${JSON.stringify({ runId, runStartedAt, ...event })}\n`;
  secureAppend(options.output, line);
  process.stdout.write(line);
}

function routerErrorCode(error, fallback) {
  return typeof error?.code === 'string' && /^router_[a-z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function blockedRouterResult(resultReason, rollback = 'not_required') {
  return {
    gate: 'blocked',
    precheck: 'unknown',
    ifupOk: false,
    pado: 'unknown',
    wanIpv4: false,
    dns: false,
    http: false,
    route: false,
    rollback,
    lock: 'unknown',
    reason: resultReason,
  };
}

async function refreshRouterPreflight(phase) {
  assertExistingControlSocket(options.routerControlSocket);
  const result = await runRouterPreflight({
    controlSocket: options.routerControlSocket,
    host: options.routerHost,
  });
  routerPreflight = result;
  record({
    timestamp: new Date().toISOString(),
    event: 'router_preflight',
    phase,
    routerPreflight,
  });
  return result;
}

async function refreshArmedStickEvidence() {
  const before = await fetchStatus(options);
  if (before.onuState !== 'O5') throw new Error('armed stick recheck did not start at O5');
  const consumerSnapshot = await captureConsumerSnapshot(options, { includeOmciMibs: true });
  const snapshotReady = consumerSnapshot.expectedManualVid === REQUIRED_MANUAL_VID
    && consumerSnapshot.localIngressConfigGate === 'ready'
    && consumerSnapshot.localIngressConsumerGate === 'ready'
    && consumerSnapshot.localIngressGate === 'ready'
    && consumerSnapshot.omciProvisioningGate === 'ready'
    && consumerSnapshot.subscriberServiceGate === 'pending_router_consumer';
  if (!snapshotReady) throw new Error('armed stick snapshot gates are not ready');
  const after = await fetchStatus(options);
  if (after.onuState !== 'O5') throw new Error('armed stick recheck did not finish at O5');
  const result = {
    gate: 'ready',
    beforeState: before.onuState,
    afterState: after.onuState,
    consumerSnapshot,
  };
  record({
    timestamp: new Date().toISOString(),
    event: 'armed_stick_recheck',
    ...result,
  });
  return result;
}

async function runRouterConsumerClosure() {
  if (!startupRouterPreflightReady || offFiberPrecutGate !== 'ready') {
    routerConsumerResult = blockedRouterResult('router_precut_sequence_incomplete');
    subscriberServiceGate = 'blocked_router_preflight';
    reason = 'router_precut_sequence_incomplete';
    finish(1);
    return;
  }
  try {
    const armedPreflight = await refreshRouterPreflight('armed');
    if (armedPreflight.gate !== 'ready') {
      routerConsumerResult = blockedRouterResult(`router_preflight_${armedPreflight.reason}`);
      subscriberServiceGate = 'blocked_router_preflight';
      reason = 'router_preflight_failed';
      finish(1);
      return;
    }
  } catch (error) {
    const failure = routerErrorCode(error, 'router_preflight_failed');
    routerPreflight = { gate: 'blocked', reason: failure };
    routerConsumerResult = blockedRouterResult(failure);
    subscriberServiceGate = 'blocked_router_preflight';
    record({
      timestamp: new Date().toISOString(),
      event: 'router_preflight',
      phase: 'armed',
      routerPreflight,
    });
    reason = 'router_preflight_failed';
    finish(1);
    return;
  }

  try {
    const armedStick = await refreshArmedStickEvidence();
    lastOmciProvisioningGate = armedStick.consumerSnapshot.omciProvisioningGate;
    lastLocalIngressGate = armedStick.consumerSnapshot.localIngressGate;
    subscriberServiceGate = armedStick.consumerSnapshot.subscriberServiceGate;
  } catch {
    const failure = 'router_armed_stick_recheck_failed';
    offFiberPrecutGate = 'invalidated';
    offFiberPrecutQualifiedAt = null;
    offFiberPrecutQualifiedSample = null;
    offFiberPrecutSequenceTainted = true;
    routerConsumerResult = blockedRouterResult(failure);
    subscriberServiceGate = 'blocked_armed_stick_recheck';
    record({
      timestamp: new Date().toISOString(),
      event: 'armed_stick_recheck',
      gate: 'blocked',
      reason: failure,
      offFiberPrecutGate,
      offFiberPrecutSequenceTainted,
    });
    reason = failure;
    finish(1);
    return;
  }

  try {
    consumeRouterAttempt(routerAttemptPath, {
      runId,
      runStartedAt,
      claimedAt: new Date().toISOString(),
      expectedManualVid: options.expectedManualVid,
    });
  } catch (error) {
    const failure = routerErrorCode(error, 'router_attempt_claim_failed');
    routerConsumerResult = blockedRouterResult(failure);
    subscriberServiceGate = 'blocked_router_consumer';
    record({
      timestamp: new Date().toISOString(),
      event: 'router_consumer',
      phase: 'attempt_not_started',
      routerConsumer: routerConsumerResult,
    });
    reason = failure;
    finish(1);
    return;
  }

  routerConsumerAttempted = true;
  record({
    timestamp: new Date().toISOString(),
    event: 'router_consumer',
    phase: 'attempt_started',
    attemptConsumed: true,
  });
  writeRunMarker('router_consumer_running', {
    startedAt: runStartedAt,
    pid: process.pid,
    samples,
    errors,
    routerConsumerAttempted,
    offFiberPrecutGate,
    offFiberPrecutQualifiedAt,
    offFiberPrecutQualifiedSample,
    evidence: options.output,
  });

  routerConsumerInFlight = true;
  routerProbeAbortController = new AbortController();
  try {
    routerConsumerResult = await runRouterWanProbe({
      controlSocket: options.routerControlSocket,
      host: options.routerHost,
      signal: routerProbeAbortController.signal,
    });
  } catch (error) {
    routerConsumerResult = blockedRouterResult(
      routerErrorCode(error, 'router_probe_incomplete'),
      'blocked',
    );
  } finally {
    routerConsumerInFlight = false;
    routerProbeAbortController = null;
  }

  if (pendingSignal !== null) {
    routerConsumerResult = {
      ...routerConsumerResult,
      gate: 'blocked',
      reason: 'router_probe_interrupted',
    };
  }

  subscriberServiceGate = routerConsumerResult.gate === 'ready'
    ? 'ready'
    : 'blocked_router_consumer';
  record({
    timestamp: new Date().toISOString(),
    event: 'router_consumer',
    phase: 'attempt_complete',
    routerConsumer: routerConsumerResult,
    subscriberServiceGate,
  });
  reason = pendingSignal ?? routerConsumerResult.reason;
  finish(pendingSignal === null && routerConsumerResult.gate === 'ready' ? 0 : 1);
}

function finish(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const result = {
    runId,
    runStartedAt,
    status: 'complete',
    finishedAt: new Date().toISOString(),
    reason,
    samples,
    errors,
    lastState,
    lastSampleOk,
    o5Observed,
    snapshotTaken,
    o5OmciSnapshotTaken,
    stableO5SnapshotTaken,
    consecutiveO5Samples,
    o5SequenceStartedAt,
    o5SequenceElapsedMs,
    lastO5SampleAt,
    o5Stable,
    lastOmciProvisioningGate,
    lastLocalIngressGate,
    routerConsumerRequested: options.routerConsumerOnReady,
    routerPreflight,
    startupRouterPreflightReady,
    routerConsumerAttempted,
    routerConsumerResult,
    subscriberServiceGate,
    offFiberPrecutGate,
    offFiberPrecutQualifiedAt,
    offFiberPrecutQualifiedSample,
    offFiberPrecutSequenceTainted,
    evidence: options.output,
  };
  assertRunLeaseOwned();
  secureAtomicWrite(options.doneMarker, `${JSON.stringify(result)}\n`);
  releaseRunLease();
  console.error(`monitor finished: ${JSON.stringify(result)}`);
  process.exit(exitCode);
}

runLeaseDescriptor = claimRunLease();
try {
  reserveFreshRunTargets();
} catch (error) {
  releaseRunLease();
  throw error;
}
writeRunMarker('running', {
  startedAt: runStartedAt,
  pid: process.pid,
  samples,
  errors,
  evidence: options.output,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const signalReason = signal.toLowerCase();
    if (routerConsumerInFlight) {
      pendingSignal = signalReason;
      routerProbeAbortController?.abort();
      console.error(`${signal} received; waiting for Router consumer cleanup`);
      return;
    }
    reason = signalReason;
    if (options.routerConsumerOnReady) {
      routerConsumerResult = blockedRouterResult('router_consumer_interrupted_before_closure');
      subscriberServiceGate = 'blocked_router_consumer';
      finish(1);
    }
    finish(0);
  });
}

if (options.routerConsumerOnReady) {
  try {
    assertExistingControlSocket(options.stickControlSocket);
    const startupPreflight = await refreshRouterPreflight('startup');
    if (startupPreflight.gate !== 'ready') {
      routerConsumerResult = blockedRouterResult(`router_preflight_${startupPreflight.reason}`);
      subscriberServiceGate = 'blocked_router_preflight';
      reason = 'router_preflight_failed';
      finish(1);
    }
    startupRouterPreflightReady = true;
  } catch (error) {
    const failure = routerErrorCode(error, 'router_preflight_failed');
    routerPreflight = { gate: 'blocked', reason: failure };
    routerConsumerResult = blockedRouterResult(failure);
    subscriberServiceGate = 'blocked_router_preflight';
    record({
      timestamp: new Date().toISOString(),
      event: 'router_preflight',
      phase: 'startup',
      routerPreflight,
    });
    reason = 'router_preflight_failed';
    finish(1);
  }
}

while (!stopping) {
  const timestamp = new Date().toISOString();
  try {
    const status = await fetchStatus(options);
    const sampleMonotonic = performance.now();
    samples += 1;
    const previousState = lastState;
    lastState = status.onuState;
    if (
      options.routerConsumerOnReady
      && offFiberPrecutGate !== 'ready'
      && status.onuState !== 'O1'
    ) {
      offFiberPrecutSequenceTainted = true;
    }
    if (
      offFiberPrecutGate === 'ready'
      && previousState !== null
      && previousState !== 'O1'
      && status.onuState === 'O1'
    ) {
      invalidateArmedPrecut('optical_state_returned_to_o1');
    }
    if (status.onuState === 'O5') {
      o5Observed = true;
      if (lastSampleOk && previousState === 'O5' && lastO5SampleAt !== null) {
        consecutiveO5Samples += 1;
      } else {
        consecutiveO5Samples = 1;
        o5SequenceStartedAt = timestamp;
        o5SequenceStartedMonotonic = sampleMonotonic;
      }
      lastO5SampleAt = timestamp;
      o5SequenceElapsedMs = sampleMonotonic - o5SequenceStartedMonotonic;
      o5Stable = isStableO5Sequence({
        consecutiveSamples: consecutiveO5Samples,
        elapsedMs: o5SequenceElapsedMs,
      });
    } else {
      consecutiveO5Samples = 0;
      o5SequenceStartedAt = null;
      o5SequenceStartedMonotonic = null;
      o5SequenceElapsedMs = 0;
      lastO5SampleAt = null;
      o5Stable = false;
      stableO5SnapshotTaken = false;
    }
    lastSampleOk = true;
    const event = { timestamp, ok: true, ...status };
    const shouldSnapshot = shouldCaptureConsumerSnapshot({
      hasControlSocket: Boolean(options.stickControlSocket),
      once: options.once,
      previousState,
      currentState: status.onuState,
      snapshotOnO5: options.snapshotOnO5,
      lastOmciProvisioningGate,
      lastLocalIngressGate,
    }) || (
      options.routerConsumerOnReady
      && offFiberPrecutGate !== 'ready'
      && !offFiberPrecutSequenceTainted
      && status.onuState === 'O1'
      && Boolean(options.stickControlSocket)
    ) || (
      Boolean(options.stickControlSocket)
      && status.onuState === 'O5'
      && o5Stable
      && !stableO5SnapshotTaken
    );
    if (shouldSnapshot) {
      try {
        event.consumerSnapshot = await captureConsumerSnapshot(options, {
          includeOmciMibs: status.onuState === 'O5',
        });
        snapshotTaken = true;
        if (status.onuState === 'O5') {
          o5OmciSnapshotTaken = true;
          if (o5Stable) stableO5SnapshotTaken = true;
        }
        lastOmciProvisioningGate = event.consumerSnapshot.omciProvisioningGate;
        lastLocalIngressGate = event.consumerSnapshot.localIngressGate;
        subscriberServiceGate = event.consumerSnapshot.subscriberServiceGate;
        if (
          offFiberPrecutGate !== 'ready'
          && isQualifiedOffFiberPrecut({
            onuState: status.onuState,
            routerPreflightGate: startupRouterPreflightReady ? 'ready' : 'blocked',
            sequenceTainted: offFiberPrecutSequenceTainted,
            expectedManualVid: options.expectedManualVid,
            snapshot: event.consumerSnapshot,
          })
        ) {
          const confirmedStatus = await fetchStatus(options);
          event.offFiberPrecutPostSnapshotState = confirmedStatus.onuState;
          if (confirmedStatus.onuState !== 'O1') {
            offFiberPrecutSequenceTainted = true;
            throw new Error('pre-cut O1 changed during qualification');
          }
          writeRunMarker('armed_for_fiber_move', {
            startedAt: runStartedAt,
            pid: process.pid,
            samples,
            errors,
            offFiberPrecutGate: 'ready',
            offFiberPrecutQualifiedAt: timestamp,
            offFiberPrecutQualifiedSample: samples,
            evidence: options.output,
          });
          offFiberPrecutGate = 'ready';
          offFiberPrecutQualifiedAt = timestamp;
          offFiberPrecutQualifiedSample = samples;
        }
      } catch (error) {
        errors += 1;
        invalidateArmedPrecut('consumer_snapshot_error');
        event.consumerSnapshotError = error.message;
        lastSampleOk = false;
        consecutiveO5Samples = 0;
        o5SequenceStartedAt = null;
        o5SequenceStartedMonotonic = null;
        o5SequenceElapsedMs = 0;
        lastO5SampleAt = null;
        o5Stable = false;
        stableO5SnapshotTaken = false;
        lastOmciProvisioningGate = 'unknown';
        lastLocalIngressGate = 'unknown';
        subscriberServiceGate = 'unknown';
      }
    }
    Object.assign(event, {
      lastSampleOk,
      consecutiveO5Samples,
      o5SequenceStartedAt,
      o5SequenceElapsedMs,
      lastO5SampleAt,
      o5Stable,
      o5OmciSnapshotTaken,
      stableO5SnapshotTaken,
      lastOmciProvisioningGate,
      lastLocalIngressGate,
      subscriberServiceGate,
      offFiberPrecutGate,
      offFiberPrecutQualifiedAt,
      offFiberPrecutQualifiedSample,
      offFiberPrecutSequenceTainted,
    });
    record(event);
    console.error(`sample=${samples} state=${status.onuState} rx=${status.rxPower} tx=${status.txPower}`);
    if (status.onuState === 'O5') {
      console.error(
        `O5 observed; OMCI provisioning=${lastOmciProvisioningGate}, subscriber service still requires router-consumer evidence`,
      );
    }
    if (options.once && event.consumerSnapshotError) {
      reason = 'snapshot_failed';
      finish(1);
    }
    if (
      options.routerConsumerOnReady
      && !routerConsumerAttempted
      && startupRouterPreflightReady
      && offFiberPrecutGate === 'ready'
      && lastSampleOk
      && status.onuState === 'O5'
      && o5Stable
      && stableO5SnapshotTaken
      && lastOmciProvisioningGate === 'ready'
      && lastLocalIngressGate === 'ready'
    ) {
      await runRouterConsumerClosure();
    }
  } catch (error) {
    if (error?.fatalRunMarker === true) throw error;
    errors += 1;
    invalidateArmedPrecut('status_poll_error');
    lastSampleOk = false;
    consecutiveO5Samples = 0;
    o5SequenceStartedAt = null;
    o5SequenceStartedMonotonic = null;
    o5SequenceElapsedMs = 0;
    lastO5SampleAt = null;
    o5Stable = false;
    stableO5SnapshotTaken = false;
    lastOmciProvisioningGate = 'unknown';
    lastLocalIngressGate = 'unknown';
    subscriberServiceGate = 'unknown';
    record({
      timestamp,
      ok: false,
      error: error.message,
      lastSampleOk,
      consecutiveO5Samples,
      o5SequenceStartedAt,
      o5SequenceElapsedMs,
      lastO5SampleAt,
      o5Stable,
      stableO5SnapshotTaken,
      lastOmciProvisioningGate,
      lastLocalIngressGate,
      subscriberServiceGate,
    });
    console.error(`sample error ${errors}: ${error.message}`);
    if (options.once) {
      reason = 'poll_failed';
      finish(1);
    }
  }

  if (options.once) {
    reason = 'single_sample_complete';
    finish(0);
  }
  if ((Date.now() - startedAt) / 1000 >= options.durationSec) {
    if (options.routerConsumerOnReady) {
      reason = 'duration_complete_without_router_consumer_closure';
      finish(1);
    }
    finish(0);
  }
  await new Promise(resolve => setTimeout(resolve, options.intervalSec * 1000));
}
