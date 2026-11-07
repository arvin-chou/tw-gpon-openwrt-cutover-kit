#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_AUDITABLE_BYTES = 2_000_000;
const OMIT_DIRECTORIES = new Set(['.git', 'node_modules']);
const errors = [];
let filesScanned = 0;

function publicIpv4(value) {
  const octets = value.split('.').map(Number);
  if (octets.some(part => part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if ((a === 192 && b === 0 && c === 2)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)) return false;
  return a > 0 && a < 224;
}

function inspectContent(content, name) {
  const text = content.toString('utf8');
  const forbidden = [
    [new RegExp(['\\/(?:Users|home)', '\\/(?!YOUR_USER\\b)[A-Za-z0-9._-]+\\/'].join('')), 'personal home path'],
    [new RegExp(['(?:\\.clau', 'de|\\.codex', '-y|\\/mem', 'ory\\/)'].join(''), 'i'), 'private memory path'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/(?:[0-9A-F]{2}:){5}[0-9A-F]{2}/i, 'MAC address'],
    [new RegExp(['\\b[A-Z]{4}', '[0-9A-F]{8}\\b'].join('')), 'GPON serial-shaped value'],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(text)) errors.push(`${name}: ${label}`);
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (publicIpv4(match[0])) errors.push(`${name}: public IPv4 address`);
  }
  const credentialAssignment = /^\s*(?:GPON_SN|GPON_PLOAM_PASSWD|PPPOE_(?:PASSWORD|USERNAME))\s*=\s*[^#\s].*$/im;
  if (credentialAssignment.test(text)) errors.push(`${name}: populated subscriber credential`);
}

function sensitiveFilename(name) {
  const basename = name.split('/').at(-1);
  if (basename !== '.env.example' && /^\.env(?:\.|$)/.test(basename)) return true;
  if (basename === '.npmrc') return true;
  return /^(?:id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|ppk|jks|keystore))$/i.test(basename);
}

function inspectAuditableContent(content, name) {
  if (content.length > MAX_AUDITABLE_BYTES) {
    errors.push(`${name}: file exceeds 2 MB audit limit`);
    return;
  }
  inspectContent(content, name);
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && OMIT_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const name = relative(ROOT, path);
    if (entry.isSymbolicLink()) {
      errors.push(`${name}: symlink is not allowed in a release`);
      continue;
    }
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (sensitiveFilename(name)) {
      errors.push(`${name}: sensitive filename`);
      continue;
    }
    filesScanned += 1;
    const size = statSync(path).size;
    if (size > MAX_AUDITABLE_BYTES) {
      errors.push(`${name}: file exceeds 2 MB audit limit`);
      continue;
    }
    inspectContent(readFileSync(path), name);
  }
}

function git(args, options = {}) {
  const result = spawnSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_AUDITABLE_BYTES + 1_000_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    errors.push(`git history: scan failed (${result.error?.message ?? String(result.stderr).trim()})`);
    return null;
  }
  return result.stdout;
}

function inspectReachableHistory() {
  if (!existsSync(resolve(ROOT, '.git'))) return;
  const objects = git(['rev-list', '--objects', '--all']);
  if (objects === null || objects.trim() === '') return;

  const names = new Map();
  for (const line of objects.trimEnd().split('\n')) {
    const separator = line.indexOf(' ');
    const object = separator < 0 ? line : line.slice(0, separator);
    const name = separator < 0 ? object : line.slice(separator + 1);
    if (!names.has(object)) names.set(object, name);
  }
  const details = git(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${[...names.keys()].join('\n')}\n` },
  );
  if (details === null) return;

  for (const line of details.trimEnd().split('\n')) {
    const [object, type, rawSize] = line.split(' ');
    if (type !== 'blob') continue;
    const name = names.get(object) ?? object;
    const label = `git history (${name})`;
    const size = Number(rawSize);
    if (sensitiveFilename(name)) errors.push(`${label}: sensitive filename`);
    if (size > MAX_AUDITABLE_BYTES) {
      errors.push(`${label}: file exceeds 2 MB audit limit`);
      continue;
    }
    const content = git(['cat-file', 'blob', object], { encoding: null });
    if (content !== null) inspectAuditableContent(content, label);
  }
}

walk(ROOT);
inspectReachableHistory();
if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ gate: 'ready', filesScanned, secretsFound: 0 })}\n`);
}
