/**
 * Rendezvous-address hardening. `socketDirRefusal` is the M1 guard: it refuses
 * to bind/connect through a unix-socket directory that another local user could
 * have squatted (the daemon's `mkdir(mode:0700)` is a no-op on a pre-existing
 * dir). Named-pipe addresses (Windows) are kernel per-user and always pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSocketFile,
  socketDirRefusal,
} from '../../src/infrastructure/index.js';

const onPosix = process.platform !== 'win32';

describe('socketDirRefusal (M1 — shared-host socket squat)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'stm-sockdir-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes a private 0700 directory owned by this user', async () => {
    const dir = join(root, 'private');
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700); // umask-proof
    expect(await socketDirRefusal(join(dir, 'daemon.sock'))).toBeNull();
  });

  it.runIf(onPosix)('refuses a group/other-accessible directory', async () => {
    const dir = join(root, 'loose');
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o777);
    const refusal = await socketDirRefusal(join(dir, 'daemon.sock'));
    expect(refusal).toMatch(/group\/other-accessible/);
  });

  it('refuses a missing directory (fail-closed)', async () => {
    const refusal = await socketDirRefusal(join(root, 'nope', 'daemon.sock'));
    expect(refusal).toMatch(/missing/);
  });

  it('is a no-op for a Windows named-pipe address', async () => {
    const pipe = '\\\\.\\pipe\\secure-telegram-mcp-abc';
    expect(isSocketFile(pipe)).toBe(false);
    expect(await socketDirRefusal(pipe)).toBeNull();
  });
});
