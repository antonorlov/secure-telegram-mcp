/**
 * Daemon — the socket-facing contract: rendezvous address shape, handshake
 * parsing, fail-closed endpoint resolution (API key is the door key), the
 * unshift-preserving handshake reader, and a REAL socket round-trip through a
 * running daemon (no Telegram: bad handshakes and locked sessions are refused
 * with secret-free reasons before any GramJS is touched).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';

import {
  daemon,
  MAX_HANDSHAKE_BYTES,
  parseHandshake,
  readHandshakeLine,
  resolveDaemonIdleMs,
  resolveHandshakeEndpoint,
} from '../../src/presentation/mcp/daemon.js';
import {
  daemonAddress,
  isSocketFile,
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import {
  Endpoint,
  EndpointName,
  PermissionVerb,
  Scope,
  SessionRef,
} from '../../src/domain/index.js';
import { unwrap } from '../../src/shared/result.js';



const endpointNamed = (name: string, tokenHash: string): Endpoint =>
  Endpoint.create({
    name: unwrap(EndpointName.create(name)),
    scope: Scope.create([], []),
    verbs: [PermissionVerb.Read],
    sessionRef: unwrap(SessionRef.create('main')),
    confirmWrites: true,
    tokenHash,
  });

describe('daemonAddress', () => {
  it('keys the address on the resolved session dir (unix socket in-dir)', () => {
    if (process.platform === 'win32') return;
    const addr = daemonAddress('/tmp/x');
    expect(addr).toBe('/tmp/x/daemon.sock');
    expect(isSocketFile(addr)).toBe(true);
  });

  it('falls back to a hashed tmpdir path when the dir would overflow sun_path', () => {
    if (process.platform === 'win32') return;
    const long = `/tmp/${'a'.repeat(150)}`;
    const addr = daemonAddress(long);
    expect(addr.length).toBeLessThanOrEqual(110);
    expect(addr).toContain('telegram-mcp-');
  });
});

describe('parseHandshake', () => {
  it('parses the complete closed v1 handshake surface', () => {
    expect(parseHandshake('{"v":1}')).toEqual({ v: 1 });
    expect(parseHandshake('{"v":1,"token":"t"}')).toEqual({ v: 1, token: 't' });
    expect(parseHandshake('{"v":1,"endpoint":"reader"}')).toEqual({
      v: 1,
      endpoint: 'reader',
    });
    expect(parseHandshake('{"v":1,"token":"t","endpoint":"reader"}')).toEqual({
      v: 1,
      token: 't',
      endpoint: 'reader',
    });
    expect(parseHandshake('{"v":1,"token":"","endpoint":""}')).toEqual({
      v: 1,
      token: '',
      endpoint: '',
    });
  });

  it.each([
    '{"v":1,"maintenance":"begin"}',
    '{"v":1,"unlock":"secret"}',
    '{"v":1,"reload":true}',
    '{"v":1,"token":"t","unexpected":true}',
    '{"v":1,"token":1}',
    '{"v":1,"endpoint":false}',
    '{"v":2}',
    '{}',
    'null',
    '[]',
    'not json',
  ])('rejects malformed or cross-plane input: %s', (line) => {
    expect(parseHandshake(line)).toBeUndefined();
  });
});

describe('resolveHandshakeEndpoint (fail-closed)', () => {
  const token = mintEndpointToken();
  const keyed = endpointNamed('reader', hashEndpointToken(token));

  it('a token resolves to exactly its endpoint', () => {
    const r = resolveHandshakeEndpoint([keyed], { v: 1, token });
    expect('endpoint' in r && String(r.endpoint.name)).toBe('reader');
  });

  it('a wrong token is refused (never falls back to name)', () => {
    const r = resolveHandshakeEndpoint([keyed], {
      v: 1,
      token: mintEndpointToken(),
      endpoint: 'reader',
    });
    expect('error' in r && r.error).toContain('unknown endpoint API key');
  });

  it('a bare name NEVER opens an endpoint — authorization is by key', () => {
    const r = resolveHandshakeEndpoint([keyed], { v: 1, endpoint: 'reader' });
    expect('error' in r && r.error).toContain('requires its API key');
  });

  it('an empty handshake is refused', () => {
    const r = resolveHandshakeEndpoint([keyed], { v: 1 });
    expect('error' in r).toBe(true);
  });
});

describe('readHandshakeLine', () => {
  it('returns the first line and unshifts the rest back onto the stream', async () => {
    const stream = new PassThrough();
    const pending = readHandshakeLine(stream as unknown as Socket, 1000);
    stream.write('{"v":1}\n{"jsonrpc":"2.0"}\n');
    const line = await pending;
    expect(line).toBe('{"v":1}');
    // The MCP bytes that followed the handshake are preserved for the transport.
    expect(String(stream.read())).toBe('{"jsonrpc":"2.0"}\n');
  });

  it('times out on a client that never sends a newline', async () => {
    const stream = new PassThrough();
    stream.write('{"v":1'); // no newline
    const line = await readHandshakeLine(stream as unknown as Socket, 50);
    expect(line).toBeUndefined();
  });

  it('rejects an oversized line even when its newline is already in the chunk', async () => {
    const stream = new PassThrough();
    const pending = readHandshakeLine(stream as unknown as Socket, 1000);
    stream.write(`${'x'.repeat(MAX_HANDSHAKE_BYTES + 1)}\n`);
    expect(await pending).toBeUndefined();
  });

  it('accepts exactly the handshake byte ceiling across chunks', async () => {
    const stream = new PassThrough();
    const pending = readHandshakeLine(stream as unknown as Socket, 1000);
    stream.write('x'.repeat(MAX_HANDSHAKE_BYTES - 1));
    stream.write('x\n');
    expect(await pending).toHaveLength(MAX_HANDSHAKE_BYTES);
  });

  // Regression: the daemon does async endpoint/scope setup BETWEEN reading the
  // handshake and attaching StdioServerTransport's 'data' listener. The stream
  // must come back PAUSED so nothing emitted in that gap is lost — a flowing
  // listener-less stream silently discards data (this ate the client's
  // `initialize` and hung every cold connection until the 30s client timeout).
  it('returns the stream paused: same-chunk trailing bytes survive a late-attaching consumer', async () => {
    const stream = new PassThrough();
    const pending = readHandshakeLine(stream as unknown as Socket, 1000);
    stream.write('{"v":1}\n{"jsonrpc":"2.0","method":"initialize"}\n');
    const line = await pending;
    expect(line).toBe('{"v":1}');
    expect(stream.isPaused()).toBe(true);

    await new Promise((r) => setTimeout(r, 30)); // the context-resolution gap
    const received: Buffer[] = [];
    stream.on('data', (c: Buffer) => received.push(c)); // = transport.start()
    stream.resume(); // the documented caller obligation (onConnection does this)
    await new Promise((r) => setTimeout(r, 10));
    expect(Buffer.concat(received).toString('utf8')).toBe(
      '{"jsonrpc":"2.0","method":"initialize"}\n',
    );
  });

  it('bytes arriving DURING the gap (separate packet) also survive', async () => {
    const stream = new PassThrough();
    const pending = readHandshakeLine(stream as unknown as Socket, 1000);
    stream.write('{"v":1}\n');
    await pending;
    stream.write('{"jsonrpc":"2.0","method":"initialize"}\n'); // lands mid-gap

    await new Promise((r) => setTimeout(r, 30));
    const received: Buffer[] = [];
    stream.on('data', (c: Buffer) => received.push(c));
    stream.resume();
    await new Promise((r) => setTimeout(r, 10));
    expect(Buffer.concat(received).toString('utf8')).toBe(
      '{"jsonrpc":"2.0","method":"initialize"}\n',
    );
  });
});

describe('daemon over a real socket (no Telegram — refusal paths)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-daemon-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const request = (address: string, line: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = netConnect(address);
      let out = '';
      socket.once('connect', () => socket.write(line));
      socket.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      socket.once('close', () => { resolve(out); });
      socket.once('error', reject);
    });

  it.skipIf(process.platform === 'win32')(
    'accepts the socket, refuses bad handshakes and locked sessions (secret-free)',
    async () => {
      const token = mintEndpointToken();
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        }),
      );
      const sessionDir = join(dir, 'secrets');
      const plain = new FileConfigRepository({ filePath: configPath });
      const exits: number[] = [];
      const logs: string[] = [];
      const started = daemon({
        // The daemon builds its own ENFORCED repo bound to the shared store; in
        // this refusal-path test a plain repo stands in (no config-auth needed).
        makeConfigRepository: () => plain,
        plainConfigRepository: plain,
        configParser: plain,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: (message) => { logs.push(message); },
        exit: (code) => {
          exits.push(code);
        },
      });
      await started;
      const address = daemonAddress(sessionDir);
      // Wait for the socket to come up.
      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        up = await new Promise((r) => {
          const probe = netConnect(address);
          probe.once('connect', () => {
            probe.destroy();
            r(true);
          });
          probe.once('error', () => { r(false); });
        });
      }
      expect(up).toBe(true);

      // Garbage handshake -> secret-free refusal.
      const bad = await request(address, 'garbage\n');
      expect(bad).toContain('malformed handshake');

      // Wrong API key -> refused without touching any session.
      const wrong = await request(
        address,
        `${JSON.stringify({ v: 1, token: mintEndpointToken() })}\n`,
      );
      expect(wrong).toContain('unknown endpoint API key');
      expect(wrong).not.toContain(token);

      // NOTE: the RIGHT key now ESTABLISHES the MCP connection (locked-but-serving);
      // the connection-time "cannot unlock" refusal is gone. That establish +
      // per-call SESSION_LOCKED behaviour is covered by daemon-locked-serving.test.ts.

      // Operator operations are physically excluded from the MCP listener.
      const crossover = await request(
        address,
        `${JSON.stringify({ v: 1, maintenance: 'begin' })}\n`,
      );
      expect(crossover).toContain('malformed handshake');
      expect(exits).toEqual([]);

      process.emit('SIGTERM', 'SIGTERM');
      for (let i = 0; i < 50 && exits.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(exits, logs.join('\n')).toEqual([0]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed on a stale socket instead of unlinking a competing owner',
    async () => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(mintEndpointToken()),
            },
          ],
        }),
      );
      const sessionDir = join(dir, 'stale-secrets');
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const address = daemonAddress(sessionDir);
      await writeFile(address, 'occupied');
      const plain = new FileConfigRepository({ filePath: configPath });

      await expect(
        daemon({
          makeConfigRepository: () => plain,
          plainConfigRepository: plain,
          configParser: plain,
          sessionDir,
          sessionKey: { kind: 'machine' },
          auditLogPath: join(dir, 'audit.log'),
          mediaRootDir: join(dir, 'media'),
          logger: () => undefined,
          exit: () => undefined,
        }),
      ).rejects.toThrow('stale local socket');

      expect(await readFile(address, 'utf8')).toBe('occupied');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'recovers both socket paths after a forced exit left a dead lifetime lease',
    async () => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(mintEndpointToken()),
            },
          ],
        }),
      );
      const sessionDir = join(dir, 'crashed-secrets');
      await mkdir(join(sessionDir, '.daemon-running'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(sessionDir, '.daemon-running', 'owner'),
        `99999999:${'0'.repeat(32)}`,
        { mode: 0o600 },
      );
      const address = daemonAddress(sessionDir);
      await writeFile(address, 'stale');
      await writeFile(operatorAddress(sessionDir), 'stale');
      const plain = new FileConfigRepository({ filePath: configPath });
      const exits: number[] = [];
      const logs: string[] = [];

      const started = daemon({
        makeConfigRepository: () => plain,
        plainConfigRepository: plain,
        configParser: plain,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: (message) => { logs.push(message); },
        exit: (code) => { exits.push(code); },
      });
      await started;

      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        up = await new Promise((resolve) => {
          const probe = netConnect(address);
          probe.once('connect', () => {
            probe.destroy();
            resolve(true);
          });
          probe.once('error', () => { resolve(false); });
        });
      }
      expect(up).toBe(true);

      process.emit('SIGTERM', 'SIGTERM');
      for (let i = 0; i < 100 && exits.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(exits, logs.join('\n')).toEqual([0]);
    },
  );
});

describe('resolveDaemonIdleMs — idle auto-lock window', () => {
  const H = 60 * 60 * 1000;
  it('is DISABLED (0) under SMOOTH (machine key) — a re-lock would just re-unlock', () => {
    expect(resolveDaemonIdleMs({}, 'machine')).toBe(0);
    // env is ignored for SMOOTH.
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: '3' }, 'machine')).toBe(0);
  });

  it('defaults to 12h under HARDENED (a PIN unlock channel)', () => {
    expect(resolveDaemonIdleMs({}, 'passphrase')).toBe(12 * H);
  });

  it('does not accept the removed daemon-prefixed environment name', () => {
    expect(
      resolveDaemonIdleMs({ TELEGRAM_MCP_DAEMON_IDLE_HOURS: '2' }, 'passphrase'),
    ).toBe(12 * H);
  });

  it('honours TELEGRAM_MCP_IDLE_HOURS (incl. fractional)', () => {
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: '2' }, 'passphrase')).toBe(2 * H);
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: '0.5' }, 'passphrase')).toBe(
      30 * 60 * 1000,
    );
  });

  it('disables (0) on an explicit 0, negative, or non-numeric value', () => {
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: '0' }, 'passphrase')).toBe(0);
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: '-4' }, 'passphrase')).toBe(0);
    expect(resolveDaemonIdleMs({ TELEGRAM_MCP_IDLE_HOURS: 'nope' }, 'passphrase')).toBe(0);
  });
});
