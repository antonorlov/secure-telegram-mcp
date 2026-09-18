// `start` as a real process on a real TTY: the masked PIN prompt, the retry loop that a paused
// stdin once broke, and the promise that the secret never reaches the terminal transcript.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');
const ENTER = '\r';

describe.skipIf(process.platform === 'win32')('cli start — PIN unlock', () => {
  guardProcessResources();
  const token = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let term: PtySession | undefined;
  let mcp: Client | undefined;

  beforeEach(async () => {
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-start-');
    await world.seal({
      config: {
        version: 1,
        endpoints: [
          {
            name: 'worker',
            session: 'acct',
            scope: { chats: [String(SCOPED_ID)], folders: [] },
            verbs: ['read'],
            tokenHash: hashEndpointToken(token),
          },
        ],
      },
      sessionRefs: ['acct'],
      pin: PIN,
    });
    // No unlock here: the daemon comes up hardened with only a machine source, i.e. locked.
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
  });

  const startCli = (): PtySession => {
    const session = spawnPty({
      command: process.execPath,
      args: [CLI, 'start'],
      env: world.childEnv({}),
      cwd: world.dir,
    });
    term = session;
    return session;
  };

  const readThroughSocket = async (): Promise<boolean> => {
    const client = new Client({ name: 'start-e2e', version: '0.0.0' });
    mcp = client;
    await client.connect(
      new SocketClientTransport(world.address(), { v: 1, token }),
    );
    const result = await client.callTool({
      name: 'list_dialogs',
      arguments: {},
    });
    return result.isError !== true;
  };

  it('a tool call fails closed until the PIN is typed, then succeeds', async () => {
    expect(await readThroughSocket()).toBe(false);
    await mcp?.close();
    mcp = undefined;

    const session = startCli();
    await session.waitFor(/PIN: /);
    session.type(`${PIN}${ENTER}`);
    expect(await session.waitForExit(20_000)).toBe(0);

    expect(await readThroughSocket()).toBe(true);
  }, 60_000);

  it('never echoes the PIN into the terminal transcript or anywhere on disk', async () => {
    const session = startCli();
    await session.waitFor(/PIN: /);
    session.type(`${PIN}${ENTER}`);
    await session.waitForExit(20_000);

    expect(session.snapshot()).toContain('*'.repeat(8));
    await world.assertNoLeaks(
      [
        { label: 'the PIN', value: PIN },
        { label: 'the endpoint key', value: token },
      ],
      { 'the terminal transcript': session.snapshot() },
    );
  }, 60_000);

  /**
   * Each wait starts past the previous match, so a CLI that printed one prompt and quit cannot
   * satisfy the loop by re-matching the prompt already on screen.
   */
  it('re-prompts after every wrong PIN and gives up after the third', async () => {
    const session = startCli();
    let cursor = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      cursor = await session.waitFor(/PIN: /, { from: cursor });
      session.type(`wrong-pin-${String(attempt)}${ENTER}`);
      cursor = await session.waitFor(/Wrong PIN/, { from: cursor });
    }
    await session.waitFor(/Too many attempts/, { from: cursor });
    const code = await session.waitForExit(20_000);

    expect(code).not.toBe(0);
    // Exactly the three the cap allows — no fourth prompt, no early exit.
    expect(session.snapshot().match(/PIN: /g)).toHaveLength(3);
    expect(await readThroughSocket()).toBe(false);
  }, 60_000);

  it('accepts the correct PIN typed after a wrong one, on the same stdin', async () => {
    const session = startCli();
    let cursor = await session.waitFor(/PIN: /);
    session.type(`definitely-not-the-pin${ENTER}`);
    cursor = await session.waitFor(/Wrong PIN/, { from: cursor });
    // The retry reads from a stdin a previous prompt explicitly paused — the regression this
    // case exists for. A fresh prompt after the refusal is the proof it resumed.
    cursor = await session.waitFor(/PIN: /, { from: cursor });
    session.type(`${PIN}${ENTER}`);
    await session.waitFor(/unlocked and running/i, { from: cursor });

    expect(await session.waitForExit(20_000)).toBe(0);
    expect(await readThroughSocket()).toBe(true);
  }, 60_000);
});
