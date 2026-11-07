#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONITOR = resolve(PACKAGE_ROOT, 'odi-scripts/gpon_cutover_monitor.mjs');
const SUPPORTED_PROFILE = 'xiaomi-be10000-qwrt-cht';
const SUPPORTED_VID = 2769;

const HELP = `gpon-cutover - fail-closed GPON stick cutover coordinator

Purpose:
  Reuse the tested ODI snapshot and OpenWrt WAN-consumer gates. The tool does
  not write GPON identity, does not accept passwords, and does not access the
  macOS Keychain. It requires existing SSH ControlMaster sockets.

Usage:
  node bin/gpon-cutover.mjs preflight [options]
  node bin/gpon-cutover.mjs cutover --apply [options]

Options:
  --env PATH             Environment file (default: ./.env)
  --state-dir PATH       Durable evidence directory (default: GPON_STATE_DIR)
  --interval-sec N       O-state polling interval, at least 30 seconds
  --duration-sec N       Maximum cutover observation period
  --apply                Required for the one-time WAN consumer
  --dry-run              Validate configuration and print the delegated argv
  --help                 Show this help

Commands:
  preflight  Read-only stick/O5/OMCI/local-ingress snapshot. Never changes WAN.
  cutover    First qualifies off-fibre O1, waits for stable O5, then performs
             one 15-second WAN probe. It commits only on full subscriber-
             service closure; otherwise the existing core rolls WAN back.

Exit codes:
  0  Requested operation completed
  1  Runtime, device, or service-closure failure
  2  Invalid usage or unsupported profile
`;

class UsageError extends Error {}

function parsePositiveInteger(value, flag, minimum = 1) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < minimum) {
    throw new UsageError(`${flag} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.length === 0) return { help: true };
  const [command, ...rest] = argv;
  if (!['preflight', 'cutover'].includes(command)) {
    throw new UsageError(`unknown command: ${command}`);
  }
  const options = {
    command,
    apply: false,
    dryRun: false,
    envPath: resolve('.env'),
    stateDir: null,
    intervalSec: null,
    durationSec: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--env') {
      const value = rest[++index];
      if (!value) throw new UsageError('--env requires a path');
      options.envPath = resolve(value);
    } else if (flag === '--state-dir') {
      const value = rest[++index];
      if (!value) throw new UsageError('--state-dir requires a path');
      options.stateDir = resolve(value);
    }
    else if (flag === '--interval-sec') {
      options.intervalSec = parsePositiveInteger(rest[++index], flag, 30);
    } else if (flag === '--duration-sec') {
      options.durationSec = parsePositiveInteger(rest[++index], flag);
    } else {
      throw new UsageError(`unknown option: ${flag}`);
    }
  }
  if (command === 'cutover' && !options.apply) {
    throw new UsageError('cutover requires explicit --apply');
  }
  if (command === 'preflight' && options.apply) {
    throw new UsageError('--apply is valid only with cutover');
  }
  return options;
}

function loadConfiguration(options) {
  if (!existsSync(options.envPath)) {
    throw new UsageError(`environment file does not exist: ${options.envPath}`);
  }
  const env = parseEnv(readFileSync(options.envPath, 'utf8'));
  const profile = env.GPON_PROFILE;
  if (profile !== SUPPORTED_PROFILE) {
    throw new UsageError(`GPON_PROFILE must be ${SUPPORTED_PROFILE}`);
  }
  const stickControlSocket = resolve(env.GPON_STICK_CONTROL_SOCKET ?? '');
  const stickHost = env.GPON_STICK_HOST ?? '';
  const expectedManualVid = parsePositiveInteger(
    env.GPON_EXPECTED_MANUAL_VID,
    'GPON_EXPECTED_MANUAL_VID',
  );
  if (expectedManualVid !== SUPPORTED_VID) {
    throw new UsageError(`this safety profile supports only Manual VID ${SUPPORTED_VID}`);
  }
  const intervalSec = options.intervalSec ?? parsePositiveInteger(
    env.GPON_INTERVAL_SEC ?? '30',
    'GPON_INTERVAL_SEC',
    30,
  );
  const durationSec = options.durationSec ?? parsePositiveInteger(
    env.GPON_DURATION_SEC ?? '1800',
    'GPON_DURATION_SEC',
  );
  const stateDir = options.stateDir ?? resolve(
    env.GPON_STATE_DIR ?? resolve(PACKAGE_ROOT, 'state'),
  );
  const config = {
    profile,
    stickControlSocket,
    stickHost,
    expectedManualVid,
    intervalSec,
    durationSec,
    stateDir,
    routerControlSocket: null,
    routerHost: null,
  };
  if (options.command === 'cutover') {
    config.routerControlSocket = resolve(env.GPON_ROUTER_CONTROL_SOCKET ?? '');
    config.routerHost = env.GPON_ROUTER_HOST ?? '';
  }
  return config;
}

function validateSshDestination(value, name) {
  if (!value || value.startsWith('-') || !/^[A-Za-z0-9_.:@%+-]+$/.test(value)) {
    throw new UsageError(`${name} must be a plain SSH destination`);
  }
}

function validateControlSocket(path, name) {
  let state;
  try {
    state = statSync(path);
  } catch {
    throw new UsageError(`${name} is not reachable: ${path}`);
  }
  if (!state.isSocket()) throw new UsageError(`${name} must be a live Unix socket`);
}

function validateConfiguration(config, command) {
  validateSshDestination(config.stickHost, 'GPON_STICK_HOST');
  validateControlSocket(config.stickControlSocket, 'GPON_STICK_CONTROL_SOCKET');
  if (command === 'cutover') {
    validateSshDestination(config.routerHost, 'GPON_ROUTER_HOST');
    validateControlSocket(config.routerControlSocket, 'GPON_ROUTER_CONTROL_SOCKET');
  }
}

function runRouterBackup(config, backupPath) {
  const result = spawnSync('ssh', [
    '-S', config.routerControlSocket,
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    config.routerHost,
    'tar', '-C', '/', '-czf', '-', 'etc/config/network',
  ], {
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8').trim() ?? 'unknown error';
    throw new Error(`Router network backup failed: ${detail}`);
  }
  writeFileSync(backupPath, result.stdout, { mode: 0o600, flag: 'wx' });
  chmodSync(backupPath, 0o600);
}

function buildMonitorArgs(config, options, outputPath, doneMarkerPath) {
  const args = [
    MONITOR,
    '--status-via-stick-ssh',
    '--snapshot-on-o5',
    '--stick-control-socket', config.stickControlSocket,
    '--stick-host', config.stickHost,
    '--expected-manual-vid', String(config.expectedManualVid),
    '--output', outputPath,
    '--done-marker', doneMarkerPath,
  ];
  if (options.command === 'preflight') return [...args, '--once'];
  return [
    ...args,
    '--interval-sec', String(config.intervalSec),
    '--duration-sec', String(config.durationSec),
    '--router-consumer-on-ready',
    '--router-control-socket', config.routerControlSocket,
    '--router-host', config.routerHost,
  ];
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const config = loadConfiguration(options);
    validateConfiguration(config, options.command);
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(config.stateDir, 0o700);

    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
    const outputPath = resolve(config.stateDir, `${runId}.jsonl`);
    const doneMarkerPath = resolve(config.stateDir, `${runId}.done`);
    const backupPath = resolve(config.stateDir, `${runId}.network-backup.tgz`);
    const monitorArgs = buildMonitorArgs(config, options, outputPath, doneMarkerPath);

    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({
        command: process.execPath,
        args: monitorArgs,
        backup: options.command === 'cutover' ? backupPath : null,
        mutatesRouter: options.command === 'cutover',
      }, null, 2)}\n`);
      return 0;
    }

    if (options.command === 'cutover') {
      runRouterBackup(config, backupPath);
      process.stderr.write(`Router network backup (mode 0600): ${backupPath}\n`);
    }
    process.stderr.write(`Evidence: ${outputPath}\nCompletion marker: ${doneMarkerPath}\n`);
    const result = spawnSync(process.execPath, monitorArgs, { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    const usage = error instanceof UsageError;
    process.stderr.write(`gpon-cutover: ${error.message}\n`);
    if (usage) process.stderr.write('Run with --help for supported usage.\n');
    return usage ? 2 : 1;
  }
}

process.exitCode = main();
