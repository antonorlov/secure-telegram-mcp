/**
 * The human-in-the-loop leg of the MCP protocol, end to end: the daemon asks the connected
 * client to confirm a write over `elicitation/create`, and only an explicit approval lets the
 * write reach Telegram. This is the one two-way branch of the protocol — everywhere else the
 * client asks and the server answers — so it is exercised against a real SDK client rather
 * than a confirmer double.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
// DEFAULT_QUOTA.messagesPerMin in the daemon.
const MESSAGES_PER_MIN = 20;

const endpoint = (name: string, token: string, confirmWrites: boolean): unknown => ({
  name,
  session: 'acct',
  scope: { chats: [String(SCOPED_ID)], folders: [] },
  verbs: ['read', 'send'],
  hitl: { confirmWrites },
  tokenHash: hashEndpointToken(token),
});

describe.skipIf(process.platform === 'win32')('write confirmation over MCP', () => {
  guardProcessResources();
  const guarded = mintEndpointToken();
  const unguarded = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  beforeEach(async () => {
    open = [];
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-hitl-');
    await world.seal({
      config: {
        version: 1,
        endpoints: [
          endpoint('guarded', guarded, true),
          endpoint('unguarded', unguarded, false),
        ],
      },
      sessionRefs: ['acct'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  interface Attached {
    readonly client: Client;
    // Every confirmation the daemon asked THIS client for, in order.
    readonly prompts: string[];
    // Resolves when the daemon actually enters THIS client's handler.
    readonly asked: Promise<string>;
    // Releases a held prompt so the handler can answer.
    readonly proceed: () => void;
  }

  // A bounded wait, so a prompt that goes to the wrong client fails as an assertion rather
  // than as a suite timeout.
  const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work.finally(() => {
        clearTimeout(timer);
      }),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${what}`));
        }, ms);
      }),
    ]);
  };

  /**
   * `answer` undefined models a client with no elicitation capability at all: it never
   * registers a handler and declares nothing. `hold` keeps the prompt open until `proceed()`,
   * which is how a case observes the daemon while a human is still deciding.
   */
  const attach = async (
    token: string,
    answer?: (message: string) => ElicitResult,
    hold = false,
  ): Promise<Attached> => {
    const prompts: string[] = [];
    let signalAsked: (message: string) => void = () => undefined;
    const asked = new Promise<string>((resolve) => {
      signalAsked = resolve;
    });
    let proceed: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const client =
      answer === undefined
        ? new Client({ name: 'hitl-test', version: '0.0.0' })
        : new Client(
            { name: 'hitl-test', version: '0.0.0' },
            { capabilities: { elicitation: {} } },
          );
    open.push(client);
    if (answer !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        signalAsked(request.params.message);
        if (hold) await gate;
        return answer(request.params.message);
      });
    }
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return { client, prompts, asked, proceed };
  };

  const approve = (): ElicitResult => ({ action: 'accept', content: { approve: true } });

  const sendResult = (client: Client, text: string): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text },
    });

  it('sends only after the operator approves, and names what is being approved', async () => {
    const { client, prompts } = await attach(guarded, approve);

    const result = await sendResult(client, 'approved');

    expect(result.isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['approved']);
    // Built from the structured request, never from Telegram prose.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("endpoint 'guarded'");
    expect(prompts[0]).toContain(String(SCOPED_ID));
  }, 20_000);

  it.each([
    ['an accepted form that says no', (): ElicitResult => ({ action: 'accept', content: { approve: false } })],
    ['a declined prompt', (): ElicitResult => ({ action: 'decline' })],
    ['a cancelled prompt', (): ElicitResult => ({ action: 'cancel' })],
  ])('refuses the write on %s, and nothing reaches Telegram', async (_label, answer) => {
    const { client, prompts } = await attach(guarded, answer);

    const result = await sendResult(client, 'never');

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CONFIRMATION_REQUIRED');
    expect(prompts).toHaveLength(1);
    expect(fake.sent).toEqual([]);
  }, 20_000);

  /**
   * The model cannot self-approve: a client that cannot show a prompt is refused rather than
   * waved through. NOTE the payload — `docs/USAGE.md` documents `CONFIRMATION_REQUIRED` here,
   * while the confirmer turns the SDK's rejection into `GATEWAY_UNAVAILABLE`. This pins what
   * the code does today; aligning the two is a product decision, not a test fix.
   */
  it('refuses a client that cannot be asked at all', async () => {
    const { client } = await attach(guarded);

    const result = await sendResult(client, 'unaskable');

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('GATEWAY_UNAVAILABLE');
    expect(fake.sent).toEqual([]);
  }, 20_000);

  /**
   * The confirmer is per CONNECTION, not per endpoint: two agents may share one endpoint, and
   * the prompt must reach the one that asked for the write. A confirmer bound to whichever
   * client connected last would still approve writes — just with the wrong human.
   */
  it('asks the connection that called, not the one that connected last', async () => {
    const caller = await attach(guarded, approve);
    const bystander = await attach(guarded, approve);

    const result = await sendResult(caller.client, 'mine to approve');

    expect(result.isError).not.toBe(true);
    expect(await within(caller.asked, 5_000, "the caller's prompt")).toContain('guarded');
    expect(caller.prompts).toHaveLength(1);
    expect(bystander.prompts).toEqual([]);
    expect(fake.sent.map((m) => m.text)).toEqual(['mine to approve']);
  }, 20_000);

  it('asks nobody for an endpoint that does not require confirmation', async () => {
    const guardedClient = await attach(guarded, approve);
    const plain = await attach(unguarded, approve);

    expect((await sendResult(plain.client, 'no prompt needed')).isError).not.toBe(true);

    expect(plain.prompts).toEqual([]);
    expect(guardedClient.prompts).toEqual([]);
    expect(fake.sent.map((m) => m.text)).toEqual(['no prompt needed']);
  }, 20_000);

  it('holds the write while the human decides, and leaves the neighbour working', async () => {
    const decider = await attach(guarded, approve, true);
    const neighbour = await attach(unguarded, approve);

    const pending = sendResult(decider.client, 'eventually');
    // Only once the daemon is genuinely waiting on THIS client is the rest meaningful.
    await within(decider.asked, 5_000, 'the prompt to reach the caller');
    expect(neighbour.prompts).toEqual([]);
    expect(fake.sent, 'nothing may be sent before the human answers').toEqual([]);

    const read = await neighbour.client.callTool({ name: 'list_dialogs', arguments: {} });
    expect(read.isError).not.toBe(true);

    decider.proceed();
    expect((await pending).isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['eventually']);
  }, 20_000);

  /**
   * Order matters: ACL, then the human, then the quota. A refused write must not consume the
   * account's anti-ban budget, or a declining operator would lock themselves out.
   */
  it('spends no anti-ban quota on refused writes', async () => {
    const refused = await attach(guarded, () => ({ action: 'decline' }));
    for (let i = 0; i <= MESSAGES_PER_MIN; i += 1) {
      expect((await sendResult(refused.client, `refused ${String(i)}`)).isError).toBe(true);
    }

    const allowed = await attach(unguarded, approve);
    expect((await sendResult(allowed.client, 'still allowed')).isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['still allowed']);
  }, 30_000);
});
