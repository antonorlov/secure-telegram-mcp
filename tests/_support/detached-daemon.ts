/**
 * The worker the published CLI starts on its own is a DETACHED process: it outlives the shim
 * that spawned it and the test that spawned the shim. Nothing else in the harness can stop it —
 * `DaemonHarness` owns in-process daemons only — so every suite that lets the CLI start one
 * cleans up through here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DaemonOwner {
  readonly pid: number;
  // The lease token; a replacement may only recover the socket once this owner is gone.
  readonly token: string;
}

const ownerPath = (sessionDir: string): string =>
  join(sessionDir, '.daemon-running', 'owner');

// The live owner recorded for this state directory, or undefined when no worker claimed it.
export const readDaemonOwner = (sessionDir: string): DaemonOwner | undefined => {
  const path = ownerPath(sessionDir);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8').trim();
  const match = /^([1-9]\d*):([a-f0-9]{32})$/.exec(raw);
  if (match === null) throw new Error(`invalid daemon owner in ${path}: ${raw}`);
  const pid = Number(match[1]);
  const token = match[2];
  if (!Number.isSafeInteger(pid) || token === undefined) {
    throw new Error(`invalid daemon owner in ${path}: ${raw}`);
  }
  return { pid, token };
};

export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'EPERM'
    );
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a worker to claim the directory; returns it, or throws with what it saw.
export const waitForDaemonOwner = async (
  sessionDir: string,
  timeoutMs = 10_000,
): Promise<DaemonOwner> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = readDaemonOwner(sessionDir);
    if (owner !== undefined && processIsAlive(owner.pid)) return owner;
    await delay(25);
  }
  throw new Error(`no daemon claimed ${sessionDir} within ${String(timeoutMs)}ms`);
};

export const waitForExit = async (pid: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
  if (processIsAlive(pid)) {
    throw new Error(`process ${String(pid)} did not exit within ${String(timeoutMs)}ms`);
  }
};

/**
 * Signals the worker that owns this state directory and waits for it to go. `SIGKILL` models an
 * unclean exit: no teardown, socket file and owner file left behind.
 */
export const stopDetachedDaemon = async (
  sessionDir: string,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<number | undefined> => {
  const owner = readDaemonOwner(sessionDir);
  if (owner === undefined) return undefined;
  try {
    process.kill(owner.pid, signal);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ESRCH'
    ) {
      return owner.pid; // already gone
    }
    throw error;
  }
  try {
    await waitForExit(owner.pid, 5_000);
  } catch (error) {
    process.kill(owner.pid, 'SIGKILL');
    throw error;
  }
  return owner.pid;
};
