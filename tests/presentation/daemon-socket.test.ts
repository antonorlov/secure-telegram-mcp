import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';

import {
  acquireDaemonProcessLease,
  acquireDaemonStartLease,
  openDaemonSocket,
  recoverStaleDaemonSocket,
} from '../../src/presentation/daemon-socket.js';

const DEAD_OWNER = `99999999:${'0'.repeat(32)}`;
const INTERRUPTED_OWNER = `99999995:${'5'.repeat(32)}`;

describe.skipIf(process.platform === 'win32')('openDaemonSocket', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
      ),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const listen = async (): Promise<{ readonly address: string; readonly root: string }> => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-socket-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    return { address, root };
  };

  it('returns an existing socket only after its directory passes verification', async () => {
    const { address } = await listen();
    const opened = await openDaemonSocket({
      address,
      daemonCommand: { execPath: '/unused', args: [] },
      unavailableError: 'unavailable',
    });

    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.destroy();
  });

  it('refuses a socket in a group-accessible directory', async () => {
    const { address, root } = await listen();
    await chmod(root, 0o750);

    const opened = await openDaemonSocket({
      address,
      daemonCommand: { execPath: '/unused', args: [] },
      unavailableError: 'unavailable',
    });

    expect(opened).toEqual({
      ok: false,
      error: `socket directory ${root} is group/other-accessible`,
    });
  });

  it('allows only one live shim to spawn a daemon for an absent socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-lease-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');

    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => acquireDaemonStartLease(address)),
    );
    expect(
      contenders.filter((result) => result.ok && result.value.acquired),
    ).toHaveLength(1);

    await Promise.all(
      contenders.map((result) =>
        result.ok ? result.value.release() : Promise.resolve(),
      ),
    );
    const replacement = await acquireDaemonStartLease(address);
    expect(replacement).toMatchObject({ ok: true, value: { acquired: true } });
    if (replacement.ok) await replacement.value.release();
  });

  it('elects one replacement when many shims recover a dead starter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-stale-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const stale = join(root, '.daemon-starting');
    await mkdir(stale, { mode: 0o700 });
    await writeFile(join(stale, 'owner'), DEAD_OWNER, { mode: 0o600 });

    const recoverers = await Promise.all(
      Array.from({ length: 32 }, () => acquireDaemonStartLease(address)),
    );
    const owners = recoverers.filter(
      (result) => result.ok && result.value.acquired,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      ok: true,
      value: { recoveredDeadOwner: true },
    });
    await Promise.all(
      recoverers.map((result) =>
        result.ok ? result.value.release() : Promise.resolve(),
      ),
    );

    const next = await acquireDaemonStartLease(address);
    expect(next).toMatchObject({ ok: true, value: { acquired: true } });
    if (next.ok) await next.value.release();
  });

  it('elects one lifetime owner when many workers recover a crashed daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-owner-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const stale = join(root, '.daemon-running');
    await mkdir(stale, { mode: 0o700 });
    await writeFile(join(stale, 'owner'), DEAD_OWNER, { mode: 0o600 });

    const contenders = await Promise.all(
      Array.from({ length: 32 }, () => acquireDaemonProcessLease(address)),
    );
    const owners = contenders.filter(
      (result) => result.ok && result.value.acquired,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      ok: true,
      value: { recoveredDeadOwner: true },
    });

    await Promise.all(
      contenders.map((result) =>
        result.ok ? result.value.release() : Promise.resolve(),
      ),
    );
  });

  it('removes stale socket paths only with proof that their owner died', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-recovery-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const operator = join(root, 'operator.sock');
    const stale = join(root, '.daemon-running');
    await mkdir(stale, { mode: 0o700 });
    await writeFile(join(stale, 'owner'), DEAD_OWNER, { mode: 0o600 });
    await writeFile(address, 'stale');
    await writeFile(operator, 'stale');

    const acquired = await acquireDaemonProcessLease(address);
    expect(acquired).toMatchObject({
      ok: true,
      value: { acquired: true, recoveredDeadOwner: true },
    });
    if (!acquired.ok) return;
    expect(await recoverStaleDaemonSocket(address, acquired.value)).toEqual({
      ok: true,
      value: true,
    });
    expect(await recoverStaleDaemonSocket(operator, acquired.value)).toEqual({
      ok: true,
      value: true,
    });

    const unrelated = join(root, 'nested', 'daemon.sock');
    expect(await recoverStaleDaemonSocket(unrelated, acquired.value)).toEqual({
      ok: false,
      error: 'stale local socket recovery is not authorized',
    });
    await acquired.value.release();
  });

  it('does not unlink a stale path without dead-owner proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-no-proof-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    await writeFile(address, 'unknown owner');

    const acquired = await acquireDaemonProcessLease(address);
    expect(acquired).toMatchObject({
      ok: true,
      value: { acquired: true, recoveredDeadOwner: false },
    });
    if (!acquired.ok) return;
    expect(await recoverStaleDaemonSocket(address, acquired.value)).toEqual({
      ok: false,
      error: 'stale local socket recovery is not authorized',
    });
    await acquired.value.release();
  });

  it('recovers an ownership claim whose remover was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-claim-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const lease = join(root, '.daemon-running');
    const claim = `owner.removing-${DEAD_OWNER.replace(':', '-')}-99999998-${'1'.repeat(16)}`;
    await mkdir(lease, { mode: 0o700 });
    await writeFile(join(lease, claim), INTERRUPTED_OWNER, { mode: 0o600 });

    const acquired = await acquireDaemonProcessLease(address);

    expect(acquired).toMatchObject({
      ok: true,
      value: { acquired: true, recoveredDeadOwner: true },
    });
    if (acquired.ok) await acquired.value.release();
  });

  it('restores a live replacement captured by an interrupted stale remover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-claim-aba-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const lease = join(root, '.daemon-running');
    const claim = `owner.removing-${DEAD_OWNER.replace(':', '-')}-99999998-${'2'.repeat(16)}`;
    const liveOwner = `${String(process.pid)}:${'e'.repeat(32)}`;
    await mkdir(lease, { mode: 0o700 });
    await writeFile(join(lease, claim), liveOwner, { mode: 0o600 });

    const acquired = await acquireDaemonProcessLease(address);

    expect(acquired).toMatchObject({ ok: true, value: { acquired: false } });
    expect((await readFile(join(lease, 'owner'), 'utf8')).trim()).toBe(liveOwner);
  });

  it('does not let a stale release remove a same-PID replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-token-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const first = await acquireDaemonStartLease(address);
    expect(first).toMatchObject({ ok: true, value: { acquired: true } });
    if (!first.ok) return;

    const replacement = `${String(process.pid)}:${'f'.repeat(32)}`;
    const ownerPath = join(root, '.daemon-starting', 'owner');
    await writeFile(ownerPath, replacement, { mode: 0o600 });
    await first.value.release();

    expect((await readFile(ownerPath, 'utf8')).trim()).toBe(replacement);
  });

  it('rebinds a real Unix socket left by a force-killed owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmcp-daemon-sigkill-'));
    roots.push(root);
    const address = join(root, 'daemon.sock');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { mkdir, writeFile } from 'node:fs/promises';
          import { createServer } from 'node:net';
          import { dirname, join } from 'node:path';
          const address = process.argv[1];
          const lease = join(dirname(address), '.daemon-running');
          await mkdir(lease, { mode: 0o700 });
          await writeFile(
            join(lease, 'owner'),
            String(process.pid) + ':00000000000000000000000000000000',
            { mode: 0o600 },
          );
          createServer().listen(address, () => process.stdout.write('ready'));
        `,
        address,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('socket owner did not become ready'));
        }, 2_000);
        const ready = (): void => {
          clearTimeout(timer);
          resolve();
        };
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`socket owner exited before ready (${String(code)})`));
        });
        child.stdout.once('data', ready);
      });
      child.kill('SIGKILL');
      await once(child, 'exit');
      expect((await lstat(address)).isSocket()).toBe(true);

      const acquired = await acquireDaemonProcessLease(address);
      expect(acquired).toMatchObject({
        ok: true,
        value: { acquired: true, recoveredDeadOwner: true },
      });
      if (!acquired.ok) return;
      expect(await recoverStaleDaemonSocket(address, acquired.value)).toEqual({
        ok: true,
        value: true,
      });

      const replacement = createServer();
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(address, resolve);
      });
      await new Promise<void>((resolve) => {
        replacement.close(() => { resolve(); });
      });
      await acquired.value.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});
