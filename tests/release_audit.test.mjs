import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const AUDIT = resolve(ROOT, 'scripts/release-audit.mjs');

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), 'release-audit-test-'));
  await mkdir(join(directory, 'scripts'));
  await copyFile(AUDIT, join(directory, 'scripts', 'release-audit.mjs'));
  return directory;
}

async function git(directory, ...args) {
  return execFileAsync('git', args, { cwd: directory });
}

async function initRepository(directory) {
  await git(directory, 'init', '--quiet');
  await git(directory, 'config', 'user.name', 'Release Audit Test');
  await git(directory, 'config', 'user.email', 'release-audit@example.invalid');
}

async function rejectedAudit(directory) {
  try {
    await execFileAsync(process.execPath, [join(directory, 'scripts', 'release-audit.mjs')]);
  } catch (error) {
    assert.equal(error.code, 1);
    return error.stderr;
  }
  throw new Error('release audit unexpectedly passed');
}

test('release audit scans forced tracked state backups regardless of extension', async () => {
  const directory = await fixture();
  try {
    const backup = join(directory, 'state', 'router-config.bak');
    await mkdir(join(directory, 'state'));
    await writeFile(join(directory, '.gitignore'), 'state/\n');
    await writeFile(backup, ['gh', 'p_', 'A'.repeat(24), '\n'].join(''));
    await initRepository(directory);
    await git(directory, 'add', 'scripts/release-audit.mjs', '.gitignore');
    await git(directory, 'add', '--force', 'state/router-config.bak');
    await git(directory, 'commit', '--quiet', '-m', 'hostile tracked backup');

    const stderr = await rejectedAudit(directory);
    assert.match(stderr, /state\/router-config\.bak: GitHub token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release audit rejects sensitive filenames and private keys in alternate extensions', async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, '.env.local'), 'SAFE=value\n');
    await writeFile(join(directory, '.npmrc'), 'registry=https://registry.example.invalid/\n');
    await writeFile(join(directory, 'client.p12'), 'placeholder\n');
    await writeFile(join(directory, 'notes.dat'), [
      '-----BEGIN OPENSSH ',
      'PRIVATE KEY-----\nplaceholder\n',
    ].join(''));

    const stderr = await rejectedAudit(directory);
    assert.match(stderr, /\.env\.local: sensitive filename/);
    assert.match(stderr, /\.npmrc: sensitive filename/);
    assert.match(stderr, /client\.p12: sensitive filename/);
    assert.match(stderr, /notes\.dat: private key block/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release audit fails closed on files larger than its scan limit', async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, 'opaque.bin'), Buffer.alloc(2_000_001));
    const stderr = await rejectedAudit(directory);
    assert.match(stderr, /opaque\.bin: file exceeds 2 MB audit limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release audit scans deleted secrets reachable from git refs', async () => {
  const directory = await fixture();
  try {
    const secretPath = join(directory, 'deleted.txt');
    await initRepository(directory);
    await writeFile(secretPath, ['gh', 'p_', 'B'.repeat(24), '\n'].join(''));
    await git(directory, 'add', 'scripts/release-audit.mjs', 'deleted.txt');
    await git(directory, 'commit', '--quiet', '-m', 'add file');
    await rm(secretPath);
    await git(directory, 'add', '--update');
    await git(directory, 'commit', '--quiet', '-m', 'delete file');

    const stderr = await rejectedAudit(directory);
    assert.match(stderr, /git history \(deleted\.txt\): GitHub token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
