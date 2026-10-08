/**
 * The access editor as an operator actually uses it: the real `setup` process on a real PTY,
 * over an account that is already saved, changing what an endpoint may do and saving it — or
 * backing out. The port-level matrix pins which rows each menu offers; this pins that the keys
 * an operator presses end in bytes on disk and a capability the daemon enforces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';
import { spawnPty, type PtySession } from '../_support/pty.js';

const SCOPED_ID = 100;
const ENDPOINT = 'worker';
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');
const ENTER = '\r';
const ESC = '\u001b';
const DOWN = '\u001b[B';

describe.skipIf(process.platform === 'win32')('setup — editing access on a PTY', () => {
  guardProcessResources();
  const token = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let term: PtySession | undefined;
  let mcp: Client | undefined;

  beforeEach(async () => {
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-access-');
    // SMOOTH, so the wizard comes up "Logged in" and the case is about access, not unlocking.
    await world.seal({
      config: {
        version: 1,
        endpoints: [
          {
            name: ENDPOINT,
            session: 'acct',
            scope: { chats: [String(SCOPED_ID)], folders: [] },
            verbs: ['read'],
            tokenHash: hashEndpointToken(token),
          },
        ],
      },
      sessionRefs: ['acct'],
    });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
  });
  afterEach(async () => {
    term?.kill();
    term = undefined;
    await mcp?.close().catch(() => undefined);
    mcp = undefined;
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const connectWith = async (key: string): Promise<Client> => {
    const client = new Client({ name: 'access-e2e', version: '0.0.0' });
    mcp = client;
    await client.connect(
      new SocketClientTransport(world.address(), { v: 1, token: key }),
    );
    return client;
  };

  // A read through whichever key is handed in — the endpoint is read-only unless a case
  // granted more.
  const canSendWith = async (key: string, tool: 'read' | 'write'): Promise<boolean> => {
    const client = await connectWith(key);
    const result = await client.callTool(
      tool === 'read'
        ? { name: 'list_dialogs', arguments: {} }
        : {
            name: 'send_message',
            arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hi' },
          },
    );
    await client.close();
    mcp = undefined;
    return result.isError !== true;
  };

  const canSend = async (): Promise<boolean> => {
    const client = new Client({ name: 'access-e2e', version: '0.0.0' });
    mcp = client;
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hi' },
    });
    await client.close();
    mcp = undefined;
    return result.isError !== true;
  };

  const grantsWrite = async (): Promise<boolean> =>
    (await readFile(world.configPath, 'utf8')).includes('"send"');

  /**
   * Walks the wizard to the access picker of the one endpoint and turns write on for the one
   * in-scope chat. Every keystroke is followed by a wait for the screen it is supposed to
   * produce, starting past the previous match — a wizard that stopped redrawing cannot satisfy
   * the next step by leaving the old screen up.
   */
  const openPickerAndGrantWrite = async (): Promise<PtySession> => {
    const session = spawnPty({
      command: process.execPath,
      args: [CLI, 'setup'],
      env: world.childEnv({}),
      cwd: world.dir,
    });
    term = session;
    let at = await session.waitFor(/Logged in/, { timeoutMs: 20_000 });

    session.type(ENTER); // Configure endpoints
    at = await session.waitFor(/Endpoints — your virtual groups/, { from: at, timeoutMs: 20_000 });
    session.type(ENTER); // the only endpoint
    at = await session.waitFor(new RegExp(`Endpoint "${ENDPOINT}"`), { from: at, timeoutMs: 20_000 });

    session.type(DOWN);
    at = await session.waitFor(/> Access — chats/, { from: at, timeoutMs: 20_000 });
    session.type(ENTER); // open the access picker
    at = await session.waitFor(/0 writable/, { from: at, timeoutMs: 20_000 });

    // The cursor starts on Saved Messages; the endpoint's chat is the next row.
    session.type(DOWN);
    at = await session.waitFor(/> \[x\] @ Scoped/, { from: at, timeoutMs: 20_000 });
    session.type('w');
    at = await session.waitFor(/1 writable/, { from: at, timeoutMs: 20_000 });

    session.type('s'); // save -> the review audit
    at = await session.waitFor(/Review — /, { from: at, timeoutMs: 20_000 });
    session.type('s'); // save again -> the typed-name gate, because write is escalation
    // The confirm line wraps at 80 columns, so match a fragment that cannot break.
    await session.waitFor(/exposes WRITE/, { from: at, timeoutMs: 20_000 });
    return session;
  };

  it('saves a granted write, and the daemon enforces it on the next call', async () => {
    expect(await canSend()).toBe(false);
    const session = await openPickerAndGrantWrite();

    // The name and the Enter go separately: Ink reads a chunk as one input, and a name with
    // a carriage return glued to it is not a submission.
    session.type(ENDPOINT);
    let at = await session.waitFor(new RegExp(`> ${ENDPOINT}_`), { timeoutMs: 20_000 });
    session.type(ENTER);
    // Back on the hub, the row now states what the endpoint may do.
    at = await session.waitFor(/read\+write/, { from: at, timeoutMs: 20_000 });
    session.type(ESC); // hub -> endpoints list
    at = await session.waitFor(/Endpoints — your virtual groups/, { from: at, timeoutMs: 20_000 });
    session.type(ESC); // list -> home
    await session.waitFor(/Logged in/, { from: at, timeoutMs: 20_000 });
    session.type('q');
    expect(await session.waitForExit(20_000)).toBe(0);

    expect(await grantsWrite()).toBe(true);
    expect(await canSend()).toBe(true);
  }, 90_000);

  it('cancelling the review gate leaves both the file and the capability alone', async () => {
    const before = await readFile(world.configPath, 'utf8');
    const session = await openPickerAndGrantWrite();

    session.type(ESC); // the gate -> back to the audit
    let at = await session.waitFor(/Review — /, { timeoutMs: 20_000 });
    session.type(ESC); // the audit -> cancel, straight back to the endpoint
    at = await session.waitFor(new RegExp(`Endpoint "${ENDPOINT}"`), { from: at, timeoutMs: 20_000 });
    // The hub states the access it still has, and it is the one that was sealed.
    const hub = session.snapshot().slice(at);
    expect(hub).toContain('0 folders · read');
    expect(hub).not.toContain('read+write');

    session.type(ESC);
    at = await session.waitFor(/Endpoints — your virtual groups/, { from: at, timeoutMs: 20_000 });
    session.type(ESC);
    await session.waitFor(/Logged in/, { from: at, timeoutMs: 20_000 });
    session.type('q');
    expect(await session.waitForExit(20_000)).toBe(0);

    expect(await readFile(world.configPath, 'utf8')).toBe(before);
    expect(await grantsWrite()).toBe(false);
    expect(await canSend()).toBe(false);
  }, 90_000);

  /**
   * The block setup prints at the end is the whole hand-off: an operator copies it into their
   * MCP client and expects that client to connect. A key that is shown but does not work, or an
   * old key that keeps working after a regeneration, are both failures of that hand-off — and
   * neither is visible from inside the wizard.
   */
  it('mints a key that really opens the endpoint, and retires the one it replaced', async () => {
    const session = spawnPty({
      command: process.execPath,
      args: [CLI, 'setup'],
      env: world.childEnv({}),
      cwd: world.dir,
    });
    term = session;
    let at = await session.waitFor(/Logged in/, { timeoutMs: 20_000 });
    session.type(ENTER);
    at = await session.waitFor(/Endpoints — your virtual groups/, { from: at, timeoutMs: 20_000 });
    session.type(ENTER);
    at = await session.waitFor(new RegExp(`Endpoint "${ENDPOINT}"`), { from: at, timeoutMs: 20_000 });

    // Name, Access, API key: two rows down from the top.
    session.type(DOWN);
    at = await session.waitFor(/> Access — chats/, { from: at, timeoutMs: 20_000 });
    session.type(DOWN);
    at = await session.waitFor(/> API key/, { from: at, timeoutMs: 20_000 });
    session.type(ENTER);
    at = await session.waitFor(/Regenerate API key/, { from: at, timeoutMs: 20_000 });
    session.type(ENTER); // the Regenerate row
    at = await session.waitFor(/Regenerate the API key\?/, { from: at, timeoutMs: 20_000 });
    session.type('y');

    // Shown once, in full, and only here.
    at = await session.waitFor(/tgmcp_/, { from: at, timeoutMs: 20_000 });
    const minted = /tgmcp_[A-Za-z0-9_-]{8,}/.exec(session.snapshot().slice(at - 200))?.[0];
    expect(minted, 'the wizard printed no key to copy').toBeDefined();
    expect(minted).not.toBe(token);

    session.kill();

    // The key from the screen opens the endpoint...
    expect(await canSendWith(minted ?? '', 'read')).toBe(true);
    // ...and the one it replaced no longer exists as far as the daemon is concerned.
    await expect(connectWith(token)).rejects.toThrow();
  }, 90_000);

  /**
   * A draft the operator hand-edited into nonsense is still THEIR draft. The wizard must say it
   * cannot edit endpoints and leave the file exactly as it found it — starting from an empty
   * baseline would overwrite the work they were trying to fix.
   */
  it('refuses to edit a malformed draft, and does not overwrite it', async () => {
    const malformed = '{"version": 1, "endpoints": [ // hand-edited into nonsense';
    await writeFile(world.configPath, malformed);

    const session = spawnPty({
      command: process.execPath,
      args: [CLI, 'setup'],
      env: world.childEnv({}),
      cwd: world.dir,
    });
    term = session;
    const at = await session.waitFor(/Logged in/, { timeoutMs: 20_000 });
    session.type(ENTER); // Configure endpoints

    await session.waitFor(/Cannot edit endpoints/, { from: at, timeoutMs: 20_000 });
    session.type('q');
    await session.waitForExit(20_000);

    expect(await readFile(world.configPath, 'utf8')).toBe(malformed);
  }, 90_000);
});
