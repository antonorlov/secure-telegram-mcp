/**
 * atomicWrite — the ONE crash-safe, owner-only file write the whole
 * infrastructure layer shares. Write a uniquely-named temp file (created
 * owner-only, 0600 — non-negotiable), fsync it, chmod to defeat umask, then atomically publish
 * it by rename (replace) or hard-link (create-new). The parent directory is
 * fsynced on POSIX so the committed entry survives power loss. A failed write
 * never leaves a partial file; the temp file is cleaned up.
 *
 * Fail-closed + secret-free: returns a Validation-free `GatewayUnavailable`
 * AppError on any I/O failure (no path echo beyond the target, no errno stack).
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppErrorCode, appError } from '../application/index.js';
import type { AppError } from '../application/index.js';
import { SECRET_MODES } from './fs-permissions.js';
import { ok, err } from '../shared/index.js';
import type { Result } from '../shared/index.js';

const syncDirectory = async (dir: string): Promise<void> => {
  // Windows does not provide portable directory handles. POSIX requires this
  // fsync for a completed rename/link to survive sudden power loss.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeTemp = async (
  path: string,
  data: string | Buffer,
  mode: number,
): Promise<void> => {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const commitAtomic = async (
  targetPath: string,
  data: string | Buffer,
  replace: boolean,
): Promise<Result<void, AppError>> => {
  const dir = dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;
  let createdTarget = false;
  try {
    await mkdir(dir, { recursive: true, mode: SECRET_MODES.dir });
    await writeTemp(tmpPath, data, SECRET_MODES.file);
    if (replace) {
      await rename(tmpPath, targetPath);
    } else {
      // A hard-link publishes the fully-synced inode atomically and fails with
      // EEXIST instead of replacing an existing destination.
      await link(tmpPath, targetPath);
      createdTarget = true;
      await rm(tmpPath);
    }
    await syncDirectory(dir);
    return ok(undefined);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    if (createdTarget) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      await syncDirectory(dir).catch(() => undefined);
    }
    return err(
      appError(AppErrorCode.GatewayUnavailable, `Failed to write ${targetPath}`),
    );
  }
};

export const atomicWrite = (
  targetPath: string,
  data: string | Buffer,
): Promise<Result<void, AppError>> => commitAtomic(targetPath, data, true);

/** Atomically create a new owner-only file; an existing path is never replaced. */
export const atomicCreate = (
  targetPath: string,
  data: string | Buffer,
): Promise<Result<void, AppError>> => commitAtomic(targetPath, data, false);
