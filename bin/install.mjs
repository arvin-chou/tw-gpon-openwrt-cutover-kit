#!/usr/bin/env node

import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELP = `install.mjs - prepare a local tw-gpon-openwrt-cutover-kit checkout

Usage:
  node bin/install.mjs [--env PATH] [--force] [--skip-tests]

Options:
  --env PATH     Destination environment file (default: ./.env)
  --force        Replace an existing environment file with .env.example
  --skip-tests   Skip the local regression and secret-release gates
  --help         Show this help

Exit codes:
  0  Checkout prepared
  1  Runtime or regression failure
  2  Invalid usage
`;

function usageError(message) {
  process.stderr.write(`install: ${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { envPath: resolve('.env'), force: false, skipTests: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (flag === '--force') options.force = true;
    else if (flag === '--skip-tests') options.skipTests = true;
    else if (flag === '--env') {
      const value = argv[++index];
      if (!value) throw new Error('--env requires a path');
      options.envPath = resolve(value);
    }
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usageError(error.message);
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 25) {
    process.stderr.write(`install: Node 25+ required; found ${process.versions.node}\n`);
    process.exitCode = 1;
    return;
  }
  const ssh = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  if (ssh.error || ssh.status !== 0) {
    process.stderr.write('install: OpenSSH client is required\n');
    process.exitCode = 1;
    return;
  }
  if (existsSync(options.envPath) && !options.force) {
    process.stderr.write(`install: preserving existing ${options.envPath}\n`);
  } else {
    copyFileSync(resolve(ROOT, '.env.example'), options.envPath, constants.COPYFILE_FICLONE);
    chmodSync(options.envPath, 0o600);
    process.stderr.write(`install: created ${options.envPath} (mode 0600)\n`);
  }
  if (!options.skipTests) {
    const test = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
    if (test.error || test.status !== 0) {
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write('Ready. Edit .env, establish both SSH ControlMaster sockets, then run npm run preflight.\n');
}

main();
