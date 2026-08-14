import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const OUTBOX_SCHEMA_VERSION = '1.0.0';

export function resolveReceiptOutboxPath(opts = {}) {
  const env = opts.env ?? process.env;
  const explicit = env.ORGX_RECEIPT_OUTBOX_PATH;
  if (typeof explicit === 'string' && explicit.trim()) {
    const path = explicit.trim();
    if (!isAbsolute(path)) {
      throw new TypeError('ORGX_RECEIPT_OUTBOX_PATH must be absolute');
    }
    return resolve(path);
  }
  const home = env.HOME || homedir();
  const stateRoot =
    env.XDG_STATE_HOME ||
    (process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'OrgX')
      : process.platform === 'win32' && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'OrgX')
      : join(home, '.local', 'state', 'orgx'));
  return resolve(stateRoot, 'deepseek-harness', 'receipt-outbox');
}

export async function ensureOutboxDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function auditUnresolvedReservations(directory) {
  await ensureOutboxDirectory(directory);
  const names = await readdir(directory);
  for (const name of names.filter((value) =>
    value.endsWith('.reservation.json')
  )) {
    const reservationPath = join(directory, name);
    const reservation = await readReservation(reservationPath);
    const receiptPath = receiptPathForRun(directory, reservation.run_id);
    if (await isRegularFile(receiptPath)) {
      await removeOutboxFile(reservationPath);
      continue;
    }
    throw new Error(
      `receipt outbox has an unresolved reservation for run ${reservation.run_id}; repair or reconcile ORGX_RECEIPT_OUTBOX_PATH before restarting the peer`
    );
  }
}

export async function persistReservationMarker(directory, started) {
  const runId = requiredString(started?.run_id, 'OrgX run id');
  const marker = {
    schema_version: OUTBOX_SCHEMA_VERSION,
    kind: 'task.reserved',
    run_id: runId,
    started_at: requiredString(started?.started_at, 'Task start time'),
  };
  const destination = reservationPathForRun(directory, runId);
  await atomicWrite(directory, destination, marker);
  return destination;
}

export async function persistReceiptEntry(directory, entry) {
  const destination = receiptPathForRun(directory, entry.run_id);
  await atomicWrite(directory, destination, entry);
  return destination;
}

export async function removeReservationMarker(directory, runId) {
  await removeOutboxFile(reservationPathForRun(directory, runId));
}

export async function listReceiptEntries(directory) {
  await ensureOutboxDirectory(directory);
  const names = (await readdir(directory))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort();
  const entries = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    await chmod(path, 0o600);
    entries.push({
      path,
      entry: parseReceiptEntry(await readFile(path, 'utf8')),
    });
  }
  return entries;
}

export async function removeOutboxFile(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function receiptPathForRun(directory, runId) {
  return join(directory, `${runHash(runId)}.json`);
}

function reservationPathForRun(directory, runId) {
  return join(directory, `${runHash(runId)}.reservation.json`);
}

function runHash(runId) {
  return createHash('sha256').update(runId).digest('hex');
}

async function atomicWrite(directory, destination, value) {
  await ensureOutboxDirectory(directory);
  const temporary = join(
    directory,
    `.${runHash(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await removeOutboxFile(temporary);
    throw error;
  }
}

async function readReservation(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('invalid receipt reservation marker');
  }
  await chmod(path, 0o600);
  const marker = JSON.parse(await readFile(path, 'utf8'));
  if (
    marker?.schema_version !== OUTBOX_SCHEMA_VERSION ||
    marker.kind !== 'task.reserved' ||
    typeof marker.run_id !== 'string' ||
    marker.run_id.trim() === ''
  ) {
    throw new Error('invalid receipt reservation marker');
  }
  return marker;
}

function parseReceiptEntry(text) {
  const entry = JSON.parse(text);
  if (
    entry?.schema_version !== OUTBOX_SCHEMA_VERSION ||
    typeof entry.run_id !== 'string' ||
    entry.run_id.trim() === '' ||
    !entry.receipt ||
    typeof entry.receipt !== 'object' ||
    Array.isArray(entry.receipt)
  ) {
    throw new Error('invalid receipt outbox entry');
  }
  return entry;
}

async function isRegularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
