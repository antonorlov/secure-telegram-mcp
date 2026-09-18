/**
 * Two things a running daemon owes the operator: an audit trail of what endpoints did, and
 * survival when a client misbehaves. Both are checked with a second, well-behaved client in the
 * room, because the answer that matters is what the neighbour experiences.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { once } from 'node:events';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { MAX_MCP_FRAME_BYTES } from '../../src/presentation/mcp/bounded-stream-transport.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const IN_SCOPE = 100;
const OUT_OF_SCOPE = 999;
const SECRET_TEXT = 'the message body must not be audited';

const token = mintEndpointToken();

const CONFIG = {
  version: 1,
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: [String(IN_SCOPE)], folders: [] },
      verbs: ['read', 'send'],
      tokenHash: hashEndpointToken(token),
    },
  ],
};

interface AuditRecord {
  readonly endpointName?: string;
  readonly verb?: string;
  readonly outcome?: string;
  readonly targetChatId?: string;
  readonly timestampIso?: string;
}

describe.skipIf(process.platform === 'win32')('audit trail and misbehaving clients', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];
  let sockets: Socket[];

  beforeEach(async () => {
    open = [];
    sockets = [];
    fake = new FakeTelegramClient(IN_SCOPE);
    world = await E2EWorld.create('tmcp-audit-');
    await world.seal({ config: CONFIG, sessionRefs: ['acct'], pin: PIN });
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const start = async (): Promise<void> => {
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
  };

  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'audit-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const send = (client: Client, peer: number): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(peer) }, text: SECRET_TEXT },
    });

  const auditRecords = async (): Promise<AuditRecord[]> => {
    const raw = await readFile(world.auditPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditRecord);
  };

  it('records the allowed and the denied write, with no message text and no key', async () => {
    await start();
    const client = await connect();

    expect((await send(client, IN_SCOPE)).isError).not.toBe(true);
    expect((await send(client, OUT_OF_SCOPE)).isError).toBe(true);

    const records = await auditRecords();
    const outcomes = records.map((record) => record.outcome);
    expect(outcomes).toContain('allow');
    expect(outcomes).toContain('deny');
    for (const record of records) {
      expect(record.endpointName).toBe('worker');
      expect(record.verb).toBe('send');
      expect(record.timestampIso).toBeDefined();
    }
    // The trail says what happened, never what was said or with which key.
    const raw = await readFile(world.auditPath, 'utf8');
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(PIN);
  }, 30_000);

  it('does not undo a completed operation when the audit sink is unusable', async () => {
    // A directory where the append-only file belongs: every write fails, nothing is written.
    await mkdir(world.auditPath, { recursive: true });
    await start();
    const client = await connect();

    const result = await send(client, IN_SCOPE);

    // Best effort by contract: the send happened, and the gap is announced in the daemon log.
    expect(result.isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual([SECRET_TEXT]);
    expect(world.daemonLog()).toContain('AUDIT WRITE FAILED');
  }, 30_000);

  describe('a misbehaving client is contained', () => {
    const misbehave = async (payload: string): Promise<boolean> => {
      const socket = netConnect(world.address());
      sockets.push(socket);
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      socket.write(`${JSON.stringify({ v: 1, token })}\n`);
      socket.write(payload);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, 2_000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    };

    it.each([
      ['a frame past the size limit', `${'x'.repeat(MAX_MCP_FRAME_BYTES + 1024)}\n`],
      ['a flood of unterminated bytes', 'y'.repeat(MAX_MCP_FRAME_BYTES + 1024)],
    ])('hangs up on %s while the neighbour keeps working', async (_label, payload) => {
      await start();
      const neighbour = await connect();
      expect((await send(neighbour, IN_SCOPE)).isError).not.toBe(true);

      expect(await misbehave(payload)).toBe(true);

      // The daemon is still there, and so is the connection it was already serving.
      expect((await send(neighbour, IN_SCOPE)).isError).not.toBe(true);
      // And a brand-new connection is still accepted.
      const fresh = await connect();
      expect((await fresh.listTools()).tools.length).toBeGreaterThan(0);
    }, 30_000);

    /**
     * Nonsense inside the frame limit is a protocol error, not an attack, and the question is
     * whether the connection is still usable afterwards. Asking for the answer to a VALID
     * request on the SAME socket is the only way to tell "survived" from "quietly closed".
     */
    it('keeps the same connection usable after a line of malformed JSON', async () => {
      await start();
      const socket = netConnect(world.address());
      sockets.push(socket);
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      const lines: string[] = [];
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        let nl = buffered.indexOf('\n');
        while (nl !== -1) {
          lines.push(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
          nl = buffered.indexOf('\n');
        }
      });
      socket.write(`${JSON.stringify({ v: 1, token })}\n`);

      socket.write('{"jsonrpc":"2.0","id":1,\n');
      socket.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'abuse-test', version: '0.0.0' },
          },
        })}\n`,
      );

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !lines.some((line) => line.includes('"id":2'))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(
        lines.some((line) => line.includes('"id":2') && line.includes('"result"')),
        `the connection answered nothing valid after the bad line: ${lines.join(' | ')}`,
      ).toBe(true);
      // And the daemon is fine for everyone else too.
      const neighbour = await connect();
      expect((await send(neighbour, IN_SCOPE)).isError).not.toBe(true);
    }, 30_000);
  });
});
