import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicCreate, atomicWrite } from '../../src/infrastructure/atomic-write.js';
import {
  FileTooLargeError,
  MAX_PASSPHRASE_FILE_BYTES,
  NotRegularFileError,
  readRegularFileBounded,
} from '../../src/infrastructure/bounded-read.js';

describe('storage primitives', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('atomicCreate publishes a complete file and never replaces an existing path', async () => {
    const path = join(dir, 'recovery.key');
    expect((await atomicCreate(path, Buffer.from('first'))).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('first');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    expect((await atomicCreate(path, Buffer.from('replacement'))).ok).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('first');
  });

  it('atomicWrite still replaces its target without leaving temporary artifacts', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, 'old', 'utf8');

    expect((await atomicWrite(path, 'new')).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('bounds regular secret files and refuses non-file paths', async () => {
    const oversized = join(dir, 'oversized.key');
    await writeFile(oversized, Buffer.alloc(MAX_PASSPHRASE_FILE_BYTES + 1));

    await expect(
      readRegularFileBounded(oversized, MAX_PASSPHRASE_FILE_BYTES),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(
      readRegularFileBounded(dir, MAX_PASSPHRASE_FILE_BYTES),
    ).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a non-terminating device before attempting to read it',
    async () => {
      await expect(
        readRegularFileBounded('/dev/zero', MAX_PASSPHRASE_FILE_BYTES),
      ).rejects.toBeInstanceOf(NotRegularFileError);
    },
  );
});
