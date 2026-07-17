import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

import { appError, AppErrorCode } from '../../src/application/index.js';
import {
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { MAX_OPERATOR_FRAME_BYTES } from '../../src/presentation/operator/protocol.js';
import {
  createOperatorServer,
  type OperatorHandlers,
} from '../../src/presentation/operator/server.js';
import { err, ok } from '../../src/shared/index.js';

describe.skipIf(process.platform === 'win32')('operator server', () => {
  let sessionDir: string;
  let server: ReturnType<typeof createOperatorServer>;
  let hardened: boolean;

  const handlers = (
    overrides: Partial<OperatorHandlers> = {},
  ): OperatorHandlers => ({
    requiresAuthentication: () => Promise.resolve(hardened),
    status: () =>
      Promise.resolve({ posture: 'hardened', locked: false, hasAccounts: false }),
    listAccounts: () => Promise.resolve(ok({ accounts: [] })),
    authenticate: (source) =>
      Promise.resolve(
        source.kind === 'passphrase' && source.passphrase === 'correct'
          ? ok(undefined)
          : err(appError(AppErrorCode.Validation, 'wrong')),
      ),
    applyPolicy: () => Promise.resolve(ok({ digest: 'a'.repeat(64) })),
    snapshotAccount: () => Promise.resolve(ok({ chats: [], folders: [] })),
    beginLogin: async (
      _owner,
      flowId,
      input,
      interaction,
    ): ReturnType<OperatorHandlers['beginLogin']> => {
      expect(input.method).toBe('phone');
      expect(await interaction.ask('phone')).toBe('+15550000000');
      return ok({
        flowId,
        account: { id: '1', displayName: 'Ada', username: 'ada_user' },
      });
    },
    commitLogin: (_owner, _flow, sessionRef) =>
      Promise.resolve(ok({ sessionRef })),
    cancelLogin: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    removeAccount: () => Promise.resolve(ok({ changed: true })),
    setPin: (): ReturnType<OperatorHandlers['setPin']> => {
      hardened = true;
      return Promise.resolve(ok({ changed: true }));
    },
    changePin: () => Promise.resolve(ok({ changed: true })),
    removePin: () => Promise.resolve(ok({ changed: true })),
    exportRecovery: (_current, _outputPath) =>
      Promise.resolve(ok({ changed: true as const })),
    ...overrides,
  });

  const listen = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(operatorAddress(sessionDir), resolve);
    });
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'tmcp-operator-'));
    hardened = true;
    server = createOperatorServer({
      handlers: handlers(),
    });
    await listen();
  });

  afterEach(async () => {
    await close();
    await rm(sessionDir, { recursive: true, force: true });
  });

  const client = (): OperatorClient =>
    new OperatorClient({
      sessionDir,
      daemonCommand: { execPath: '/unused', args: [] },
    });

  it('binds authentication to one connection and supports login prompts', async () => {
    const first = client();
    expect((await first.connect()).ok).toBe(true);
    expect((await first.status()).ok).toBe(true);
    expect((await first.listAccounts()).ok).toBe(false);
    expect((await first.snapshotAccount('main')).ok).toBe(false);
    expect(
      (
        await first.authenticate({
          kind: 'passphrase',
          passphrase: 'correct',
        })
      ).ok,
    ).toBe(true);
    expect((await first.listAccounts()).ok).toBe(true);
    expect((await first.snapshotAccount('main')).ok).toBe(true);

    const login = await first.login({
      apiId: 1,
      apiHash: 'a'.repeat(32),
      method: 'phone',
      onQr: () => undefined,
      ask: (kind) => Promise.resolve(kind === 'phone' ? '+15550000000' : ''),
    });
    expect(login).toMatchObject({
      ok: true,
      value: { account: { displayName: 'Ada' } },
    });
    first.close();

    const second = client();
    expect((await second.connect()).ok).toBe(true);
    expect((await second.snapshotAccount('main')).ok).toBe(false);
    second.close();
  });

  it('rechecks authorization after a queued smooth-to-hardened transition', async () => {
    await close();
    hardened = false;
    let startPin!: () => void;
    const pinStarted = new Promise<void>((resolve) => {
      startPin = resolve;
    });
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    let policyCalls = 0;
    server = createOperatorServer({
      handlers: handlers({
        setPin: async () => {
          startPin();
          await pinGate;
          hardened = true;
          return ok({ changed: true });
        },
        applyPolicy: () => {
          policyCalls += 1;
          return Promise.resolve(ok({ digest: 'must-not-run' }));
        },
      }),
    });
    await listen();
    const setter = client();
    const writer = client();
    expect((await setter.connect()).ok).toBe(true);
    expect((await writer.connect()).ok).toBe(true);

    const setting = setter.setPin(
      { kind: 'machine' },
      { kind: 'passphrase', passphrase: 'new-pin' },
    );
    await pinStarted;
    const applying = writer.applyPolicy('{"version":1}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(policyCalls).toBe(0);
    let drained = false;
    const draining = server.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);

    releasePin();
    expect((await setting).ok).toBe(true);
    expect((await applying).ok).toBe(false);
    await draining;
    expect(drained).toBe(true);
    expect(policyCalls).toBe(0);
    setter.close();
    writer.close();
  });

  it.each(['accounts.list', 'account.snapshot'] as const)(
    'orders %s before a concurrent PIN transition',
    async (operation) => {
      await close();
      hardened = false;
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => { readStarted = resolve; });
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      const calls: string[] = [];
      const guardedRead = async (): Promise<void> => {
        readStarted();
        await readGate;
        calls.push(operation);
      };
      server = createOperatorServer({
        handlers: handlers({
          listAccounts: async () => {
            if (operation === 'accounts.list') await guardedRead();
            return ok({ accounts: [] });
          },
          snapshotAccount: async () => {
            if (operation === 'account.snapshot') await guardedRead();
            return ok({ chats: [], folders: [] });
          },
          setPin: () => {
            calls.push('pin.set');
            hardened = true;
            return Promise.resolve(ok({ changed: true }));
          },
        }),
      });
      await listen();
      const reader = client();
      const setter = client();
      expect((await reader.connect()).ok).toBe(true);
      expect((await setter.connect()).ok).toBe(true);

      const reading = operation === 'accounts.list'
        ? reader.listAccounts()
        : reader.snapshotAccount('main');
      await started;
      const setting = setter.setPin(
        { kind: 'machine' },
        { kind: 'passphrase', passphrase: 'new-pin' },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([]);

      releaseRead();
      expect((await reading).ok).toBe(true);
      expect((await setting).ok).toBe(true);
      expect(calls).toEqual([operation, 'pin.set']);
      reader.close();
      setter.close();
    },
  );

  it('revokes an in-flight login before publishing a PIN transition', async () => {
    await close();
    hardened = false;
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let loginAborted = false;
    let cancelCalls = 0;
    const qrUrls: string[] = [];
    server = createOperatorServer({
      handlers: handlers({
        beginLogin: async (
          _ownerId,
          flowId,
          _input,
          interaction,
        ) => {
          await interaction.qr({ url: 'tg://before', expiresInSeconds: 60 });
          loginStarted();
          await new Promise<void>((resolve) => {
            interaction.signal.addEventListener('abort', () => {
              loginAborted = true;
              resolve();
            }, { once: true });
          });
          await interaction.qr({ url: 'tg://after', expiresInSeconds: 60 });
          return ok({
            flowId,
            account: { id: '1', displayName: 'Pending account' },
          });
        },
        cancelLogin: () => {
          cancelCalls += 1;
          return Promise.resolve();
        },
      }),
    });
    await listen();
    const loginClient = client();
    const setter = client();
    expect((await loginClient.connect()).ok).toBe(true);
    expect((await setter.connect()).ok).toBe(true);

    const login = loginClient.login({
      apiId: 1,
      apiHash: 'a'.repeat(32),
      method: 'qr',
      onQr: ({ url }) => { qrUrls.push(url); },
      ask: () => Promise.resolve(''),
    });
    await started;
    const setting = await setter.setPin(
      { kind: 'machine' },
      { kind: 'passphrase', passphrase: 'new-pin' },
    );

    expect(setting.ok).toBe(true);
    expect(loginAborted).toBe(true);
    expect(await login).toEqual({
      ok: false,
      error: 'operator authentication required',
    });
    expect(qrUrls).toEqual(['tg://before']);
    expect(cancelCalls).toBe(1);
    loginClient.close();
    setter.close();
  });

  it('invalidates every other authenticated socket after a PIN change', async () => {
    const first = client();
    const second = client();
    expect((await first.connect()).ok).toBe(true);
    expect((await second.connect()).ok).toBe(true);
    for (const operator of [first, second]) {
      expect(
        (
          await operator.authenticate({
            kind: 'passphrase',
            passphrase: 'correct',
          })
        ).ok,
      ).toBe(true);
    }

    expect(
      (
        await first.changePin(
          { kind: 'passphrase', passphrase: 'correct' },
          { kind: 'passphrase', passphrase: 'replacement' },
        )
      ).ok,
    ).toBe(true);
    expect((await first.listAccounts()).ok).toBe(true);
    expect((await second.listAccounts()).ok).toBe(false);
    first.close();
    second.close();
  });

  it('revokes an in-flight login prompt when another socket changes the PIN', async () => {
    const first = client();
    const second = client();
    expect((await first.connect()).ok).toBe(true);
    expect((await second.connect()).ok).toBe(true);
    for (const operator of [first, second]) {
      expect(
        (
          await operator.authenticate({
            kind: 'passphrase',
            passphrase: 'correct',
          })
        ).ok,
      ).toBe(true);
    }

    let prompt!: () => void;
    const prompted = new Promise<void>((resolve) => { prompt = resolve; });
    let answer!: (value: string) => void;
    const login = first.login({
      apiId: 1,
      apiHash: 'a'.repeat(32),
      method: 'phone',
      onQr: () => undefined,
      ask: () => {
        prompt();
        return new Promise<string>((resolve) => { answer = resolve; });
      },
    });
    await prompted;

    expect(
      (
        await second.changePin(
          { kind: 'passphrase', passphrase: 'correct' },
          { kind: 'passphrase', passphrase: 'replacement' },
        )
      ).ok,
    ).toBe(true);
    answer('+15550000000');

    expect((await login).ok).toBe(false);
    expect((await first.listAccounts()).ok).toBe(false);
    first.close();
    second.close();
  });

  it('closes a connection that never sends a valid first frame', async () => {
    await close();
    server = createOperatorServer({
      handlers: handlers(),
      firstFrameTimeoutMs: 20,
    });
    await listen();
    const socket = netConnect(operatorAddress(sessionDir));
    let output = '';
    socket.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    await new Promise<void>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    expect(output).toContain('operator request timed out');
  });

  it('destroys a socket that floods past the hard queued-request cap (32)', async () => {
    await close();
    let statusCalls = 0;
    server = createOperatorServer({
      handlers: handlers({
        status: () => {
          statusCalls += 1;
          return Promise.resolve({
            posture: 'hardened',
            locked: false,
            hasAccounts: false,
          });
        },
      }),
    });
    await listen();
    const socket = netConnect(operatorAddress(sessionDir));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let received = '';
    const closed = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
      socket.once('close', resolve);
    });
    // One chunk = the framer enqueues all 40 lines in one synchronous pass, so
    // no handler can release a slot in between: the 33rd request MUST trip the
    // hard cap and destroy the socket (deterministic, not racy).
    socket.write(
      Array.from({ length: 40 }, (_, index) =>
        `${JSON.stringify({ v: 1, id: String(index), op: 'status' })}\n`,
      ).join(''),
    );
    await closed;
    expect(received).toContain('too many queued operator requests');
    expect(statusCalls).toBeLessThanOrEqual(32);
  });

  it('stops processing queued requests while response output is backpressured', async () => {
    await close();
    const padding = 'x'.repeat(2 * 1024 * 1024);
    let statusCalls = 0;
    let firstStatus!: () => void;
    const firstStatusCalled = new Promise<void>((resolve) => {
      firstStatus = resolve;
    });
    server = createOperatorServer({
      handlers: handlers({
        status: () => {
          statusCalls += 1;
          if (statusCalls === 1) firstStatus();
          return Promise.resolve({
            posture: 'hardened',
            locked: false,
            hasAccounts: false,
            padding,
          });
        },
      }),
    });
    await listen();
    const socket = netConnect(operatorAddress(sessionDir));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    try {
      socket.pause();
      socket.write(
        Array.from({ length: 3 }, (_, index) =>
          `${JSON.stringify({ v: 1, id: String(index), op: 'status' })}\n`,
        ).join(''),
      );
      await firstStatusCalled;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(statusCalls).toBe(1);

      let output = '';
      const received = new Promise<void>((resolve) => {
        socket.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.split('\n').length === 4) resolve();
        });
      });
      socket.resume();
      await received;

      expect(statusCalls).toBe(3);
      expect(
        output
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { id: string }).id),
      ).toEqual(['0', '1', '2']);
    } finally {
      socket.destroy();
    }
  });

  it('destroys a socket sending an OVERSIZED frame (no unbounded buffering)', async () => {
    hardened = false;
    const socket = netConnect(operatorAddress(sessionDir));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('error', () => undefined); // server destroys mid-write -> EPIPE here
    socket.resume(); // a paused socket never observes the server's EOF
    const closed = new Promise<void>((resolve) => {
      socket.once('close', resolve);
    });
    // One line larger than the frame cap: the bounded framer must refuse it
    // rather than buffer it, and the server destroys the connection.
    socket.write(`${'x'.repeat(MAX_OPERATOR_FRAME_BYTES + 1)}\n`);
    await closed;
    expect(socket.destroyed).toBe(true);
  }, 15_000);

  it('rejects a malformed request line and keeps serving the connection', async () => {
    hardened = false;
    const socket = netConnect(operatorAddress(sessionDir));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.write('this is not json\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toContain('malformed operator request');
    // The connection SURVIVES a malformed line — a valid request still answers.
    socket.write(`${JSON.stringify({ v: 1, id: 'ok-1', op: 'status' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toContain('"posture"');
    const closed = new Promise<void>((resolve) => {
      socket.once('close', resolve);
    });
    socket.end();
    await closed;
  });

  it('destroys a socket flooding login.answer past the answer cap (32)', async () => {
    hardened = false;
    const socket = netConnect(operatorAddress(sessionDir));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let received = '';
    const closed = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      socket.once('close', resolve);
    });
    // One chunk of 40 answers: the per-socket answerOperations cap must trip.
    socket.write(
      Array.from({ length: 40 }, (_, index) =>
        `${JSON.stringify({
          v: 1,
          id: `a-${String(index)}`,
          op: 'login.answer',
          flowId: 'flow-x',
          promptId: 'prompt-x',
          value: 'v',
        })}\n`,
      ).join(''),
    );
    await closed;
    expect(received).toContain('too many operator answers in flight');
    expect(socket.destroyed).toBe(true);
  });
});
