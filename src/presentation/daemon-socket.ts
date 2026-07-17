import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';

import {
  isSocketFile,
  socketDirRefusal,
} from '../infrastructure/daemon-address.js';
import { daemonSpawnEnvironment } from '../infrastructure/daemon-environment.js';
import { err, ok, type Result } from '../shared/index.js';

export interface DaemonCommand {
  readonly execPath: string;
  readonly args: readonly string[];
}

const tryConnect = (address: string): Promise<Socket | undefined> =>
  new Promise((resolve) => {
    const socket = netConnect(address);
    socket.once('connect', () => { resolve(socket); });
    socket.once('error', () => { resolve(undefined); });
  });

const START_LEASE_FILE = '.daemon-starting';
const PROCESS_LEASE_FILE = '.daemon-running';
const START_LEASE_OWNER = 'owner';
const LEASE_ID_PATTERN = '[a-f0-9]{32}';
const REMOVAL_ID_PATTERN = '[a-f0-9]{16}';
const LEASE_OWNER_RE = new RegExp(`^([1-9]\\d*):(${LEASE_ID_PATTERN})$`);
const REMOVAL_CLAIM_RE = new RegExp(
  `^${START_LEASE_OWNER}\\.removing-([1-9]\\d*)-(${LEASE_ID_PATTERN})-([1-9]\\d*)-(${REMOVAL_ID_PATTERN})$`,
);
const DEFAULT_START_TIMEOUT_MS = 15_000;

interface LeaseOwner {
  readonly pid: number;
  readonly id: string;
  readonly raw: string;
}

interface RemovalClaim {
  readonly fileName: string;
  readonly owner: LeaseOwner;
  readonly removerPid: number;
}

export interface DaemonLease {
  readonly acquired: boolean;
  /** True only when this acquisition replaced a lease owned by a dead PID. */
  readonly recoveredDeadOwner: boolean;
  readonly directory: string;
  release(): Promise<void>;
}

const leaseDirectory = (address: string): string =>
  isSocketFile(address)
    ? dirname(address)
    : join(
        tmpdir(),
        `secure-telegram-mcp-start-${createHash('sha256')
          .update(address, 'utf8')
          .digest('hex')
          .slice(0, 12)}`,
      );

const leaseOwner = (): LeaseOwner => {
  const id = randomBytes(16).toString('hex');
  return { pid: process.pid, id, raw: `${String(process.pid)}:${id}` };
};

const parseLeaseOwner = (raw: string): LeaseOwner | undefined => {
  const match = LEASE_OWNER_RE.exec(raw.trim());
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const id = match[2];
  if (!Number.isSafeInteger(pid) || id === undefined) return undefined;
  return { pid, id, raw: `${String(pid)}:${id}` };
};

const removalClaim = (owner: LeaseOwner): RemovalClaim => ({
  fileName: `${START_LEASE_OWNER}.removing-${String(owner.pid)}-${owner.id}-${String(process.pid)}-${randomBytes(8).toString('hex')}`,
  owner,
  removerPid: process.pid,
});

const parseRemovalClaim = (fileName: string): RemovalClaim | undefined => {
  const match = REMOVAL_CLAIM_RE.exec(fileName);
  if (match === null) return undefined;
  const ownerPid = Number(match[1]);
  const ownerId = match[2];
  const removerPid = Number(match[3]);
  if (
    !Number.isSafeInteger(ownerPid) ||
    !Number.isSafeInteger(removerPid) ||
    ownerId === undefined
  ) {
    return undefined;
  }
  return {
    fileName,
    owner: {
      pid: ownerPid,
      id: ownerId,
      raw: `${String(ownerPid)}:${ownerId}`,
    },
    removerPid,
  };
};

type ClaimOutcome = 'acquired' | 'live' | 'retry';

/** Publish a new exact owner while the claim keeps the lease directory non-empty. */
const publishClaimedOwner = async (
  leasePath: string,
  claimPath: string,
  candidateOwnerPath: string,
): Promise<void> => {
  // The candidate record was fully written before contention began. Replacing
  // the sole claim first preserves a one-marker state machine: either rename may
  // fail, but acquisition can always recover the remaining complete record.
  await rename(candidateOwnerPath, claimPath);
  await rename(claimPath, join(leasePath, START_LEASE_OWNER));
};

const replaceDeadOwner = async (
  leasePath: string,
  expected: LeaseOwner,
  candidateOwnerPath: string,
): Promise<ClaimOutcome> => {
  const ownerPath = join(leasePath, START_LEASE_OWNER);
  const claim = removalClaim(expected);
  const claimPath = join(leasePath, claim.fileName);
  try {
    await rename(ownerPath, claimPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'retry';
    throw error;
  }

  const claimedRaw = (await readFile(claimPath, 'utf8')).trim();
  if (claimedRaw !== expected.raw || processIsAlive(expected.pid)) {
    await rename(claimPath, ownerPath);
    return claimedRaw === expected.raw ? 'live' : 'retry';
  }

  await publishClaimedOwner(leasePath, claimPath, candidateOwnerPath);
  return 'acquired';
};

/** Resume a remover killed after it claimed `owner` but before it published. */
const recoverInterruptedRemoval = async (
  leasePath: string,
  candidateOwnerPath: string,
): Promise<ClaimOutcome> => {
  let names: string[];
  try {
    names = await readdir(leasePath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'retry';
    throw error;
  }
  if (names.includes(START_LEASE_OWNER)) return 'retry';
  const claims = names
    .map(parseRemovalClaim)
    .filter((claim): claim is RemovalClaim => claim !== undefined);
  if (claims.length !== 1 || names.length !== 1) {
    throw new Error('invalid lease removal claim');
  }
  const staleClaim = claims[0];
  if (staleClaim === undefined || processIsAlive(staleClaim.removerPid)) {
    return 'live';
  }

  const nextClaim = removalClaim(staleClaim.owner);
  const stalePath = join(leasePath, staleClaim.fileName);
  const nextPath = join(leasePath, nextClaim.fileName);
  try {
    await rename(stalePath, nextPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'retry';
    throw error;
  }
  // A delayed remover may have claimed a replacement owner before it noticed
  // the lease ID mismatch. Trust a complete record in the claimed file over the
  // older identity encoded in its filename.
  const recorded = parseLeaseOwner(await readFile(nextPath, 'utf8'));
  const claimedOwner = recorded ?? staleClaim.owner;
  if (processIsAlive(claimedOwner.pid)) {
    if (recorded === undefined) {
      await rename(nextPath, stalePath);
    } else {
      await rename(nextPath, join(leasePath, START_LEASE_OWNER));
    }
    return 'live';
  }
  await publishClaimedOwner(leasePath, nextPath, candidateOwnerPath);
  return 'acquired';
};

const unacquiredLease = (directory: string): DaemonLease => ({
  acquired: false,
  recoveredDeadOwner: false,
  directory,
  release: () => Promise.resolve(),
});

const acquiredLease = (
  directory: string,
  leasePath: string,
  owner: LeaseOwner,
  recoveredDeadOwner: boolean,
): DaemonLease => {
  let releasePromise: Promise<void> | undefined;
  return {
    acquired: true,
    recoveredDeadOwner,
    directory,
    release: (): Promise<void> => {
      releasePromise ??= removeOwnedLease(leasePath, owner);
      return releasePromise;
    },
  };
};

const acquireDaemonLease = async (
  address: string,
  leaseName: string,
): Promise<Result<DaemonLease, string>> => {
  const directory = leaseDirectory(address);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const refusal = isSocketFile(address)
    ? await socketDirRefusal(join(directory, 'lease.sock'))
    : null;
  if (refusal !== null) return err(refusal);
  const leasePath = join(directory, leaseName);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = leaseOwner();
    const candidatePath = `${leasePath}.${String(owner.pid)}-${owner.id}`;
    const candidateOwnerPath = join(candidatePath, START_LEASE_OWNER);
    try {
      await mkdir(candidatePath, { mode: 0o700 });
      await writeFile(candidateOwnerPath, owner.raw, {
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
      return err('could not coordinate Telegram MCP startup');
    }

    try {
      // Publishing a fully-built, non-empty directory is atomic.
      await rename(candidatePath, leasePath);
      return ok(acquiredLease(directory, leasePath, owner, false));
    } catch {
      try {
        if (!(await lstat(leasePath)).isDirectory()) {
          return err('could not coordinate Telegram MCP startup');
        }
      } catch {
        return err('could not coordinate Telegram MCP startup');
      }
      try {
        let existing: LeaseOwner | undefined;
        try {
          existing = parseLeaseOwner(
            await readFile(join(leasePath, START_LEASE_OWNER), 'utf8'),
          );
        } catch (ownerError) {
          if (errnoCode(ownerError) !== 'ENOENT') throw ownerError;
          const outcome = await recoverInterruptedRemoval(
            leasePath,
            candidateOwnerPath,
          );
          if (outcome === 'acquired') {
            return ok(acquiredLease(directory, leasePath, owner, true));
          }
          if (outcome === 'live') {
            return ok(unacquiredLease(directory));
          }
          continue;
        }
        if (existing === undefined) {
          return err('could not verify Telegram MCP process owner');
        }
        if (processIsAlive(existing.pid)) {
          return ok(unacquiredLease(directory));
        }
        const outcome = await replaceDeadOwner(
          leasePath,
          existing,
          candidateOwnerPath,
        );
        if (outcome === 'acquired') {
          return ok(acquiredLease(directory, leasePath, owner, true));
        }
        if (outcome === 'live') {
          return ok(unacquiredLease(directory));
        }
      } catch (error) {
        const code = errnoCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          return err('could not coordinate Telegram MCP startup');
        }
      }
    } finally {
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return ok(unacquiredLease(directory));
};

/** Prevent concurrent shims from spawning duplicate daemon workers. */
export const acquireDaemonStartLease = (
  address: string,
): Promise<Result<DaemonLease, string>> =>
  acquireDaemonLease(address, START_LEASE_FILE);

/** Held by the daemon until Telegram ownership and its socket are both gone. */
export const acquireDaemonProcessLease = (
  address: string,
): Promise<Result<DaemonLease, string>> =>
  acquireDaemonLease(address, PROCESS_LEASE_FILE);

/**
 * Remove a crashed daemon's socket only when its lifetime lease proved the owner
 * PID dead. The inode check prevents replacing a path that changed during the
 * liveness probe.
 */
export const recoverStaleDaemonSocket = async (
  address: string,
  lease: DaemonLease,
): Promise<Result<boolean, string>> => {
  if (
    !isSocketFile(address) ||
    !lease.acquired ||
    !lease.recoveredDeadOwner ||
    dirname(address) !== lease.directory
  ) {
    return err('stale local socket recovery is not authorized');
  }
  let before;
  try {
    before = await lstat(address);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return ok(false);
    return err('could not inspect stale local socket');
  }

  const live = await tryConnect(address);
  if (live !== undefined) {
    live.destroy();
    return err('local socket still accepts connections');
  }

  try {
    const after = await lstat(address);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      return err('local socket changed during recovery');
    }
    await unlink(address);
    return ok(true);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return ok(false);
    return err('could not remove stale local socket');
  }
};

const errnoCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const removeOwnedLease = async (
  leasePath: string,
  owner: LeaseOwner,
): Promise<void> => {
  const ownerPath = join(leasePath, START_LEASE_OWNER);
  const claim = removalClaim(owner);
  const claimedOwnerPath = join(leasePath, claim.fileName);
  const retiredPath = `${leasePath}.retired-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
  try {
    // Claim the exact owner marker before checking it. Only one stale cleaner can
    // move this path, and the non-empty lease directory cannot be replaced while
    // the claim remains inside it.
    await rename(ownerPath, claimedOwnerPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }

  let retired = false;
  try {
    const recorded = (await readFile(claimedOwnerPath, 'utf8')).trim();
    if (recorded !== owner.raw) {
      await rename(claimedOwnerPath, ownerPath);
      return;
    }

    // Move the still-non-empty directory out of the canonical path atomically.
    // Cleanup can now be delayed without ever touching a replacement lease.
    await rename(leasePath, retiredPath);
    retired = true;
    await rm(retiredPath, { recursive: true, force: true });
  } catch (error) {
    if (!retired) {
      await rename(claimedOwnerPath, ownerPath).catch(() => undefined);
    }
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'EPERM'
    );
  }
};

/** Connect to the daemon, starting it once when absent, then verify its trust boundary. */
export const openDaemonSocket = async (options: {
  readonly address: string;
  readonly daemonCommand: DaemonCommand;
  readonly unavailableError: string;
}): Promise<Result<Socket, string>> => {
  let socket = await tryConnect(options.address);
  if (socket === undefined) {
    const leaseResult = await acquireDaemonStartLease(options.address);
    if (!leaseResult.ok) return leaseResult;
    const lease = leaseResult.value;
    try {
      if (lease.acquired) {
        // The initial connect and lease acquisition are separate syscalls. A
        // concurrent winner may have bound between them, so check once more
        // before paying for another daemon process.
        socket = await tryConnect(options.address);
        if (socket === undefined) {
          const child = spawn(
            options.daemonCommand.execPath,
            [...options.daemonCommand.args],
            {
              detached: true,
              stdio: 'ignore',
              env: daemonSpawnEnvironment(process.env),
            },
          );
          child.once('error', () => undefined);
          child.unref();
        }
      }

      const deadline = performance.now() + DEFAULT_START_TIMEOUT_MS;
      while (socket === undefined && performance.now() < deadline) {
        await delay(50);
        socket = await tryConnect(options.address);
      }
    } finally {
      await lease.release();
    }
  }
  if (socket === undefined) return err(options.unavailableError);

  const refusal = await socketDirRefusal(options.address);
  if (refusal !== null) {
    socket.destroy();
    return err(refusal);
  }
  return ok(socket);
};
