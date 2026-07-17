/**
 * Integration test for the wired tool catalogue + STATIC full-menu registry.
 *
 * Proves the headline invariant "the menu is DISCOVERY; EXECUTION is the ACL"
 * end-to-end through the REAL presentation spine: `buildToolDefinitions`
 * assembles every core tool, and `buildEndpointServer` (via
 * `VerbGatedToolRegistry`) registers the FULL non-forbidden catalogue for EVERY
 * endpoint, regardless of its verbs or the kill-switch. A read-only-everywhere
 * endpoint therefore LISTS the write tools too (they DENY at execution — proven
 * by the scoped-client-invariant / use-case / completeness suites).
 *
 * It also asserts the structural guarantees the integration must keep:
 *  - the catalogue exposes exactly the v1 core tools (no stub/extra tools);
 *  - no forbidden raw/scope-mutation tool name (#2) ever appears — even under a
 *    static menu, bypass tools are NEVER registered;
 *  - EVERY tool declares an `outputSchema` (F9) advertised over tools/list;
 *    a REPRESENTATIVE SUBSET (7 of the 18 operations) is additionally
 *    round-tripped through a live client<->server pair — the SDK validates
 *    each success result's structuredContent against the declared schema, and
 *    each round-trip pins the exact scoped operation reached (tool->spec
 *    wiring). The remaining tools are covered by the declaration/advertising
 *    assertions and the completeness suites, not by round-trips.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, type Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PermissionVerb,
  UntrustedText,
  UntrustedTextKind,
  type EndpointNameValue,
} from '../../src/domain/index.js';
import {
  type AppError,
  type EndpointExecutionContext,
  type WriteUseCaseDeps,
  type MessageDto,
  type MediaFileDto,
  type ParticipantDto,
  type Page,
  type SendResultDto,
  type ReactionResultDto,
  type GetMessagesQuery,
  type SearchMessagesQuery,
  type GetPinnedQuery,
  type ListParticipantsQuery,
  type DownloadMediaQuery,
  type SendMessageCommand,
  type SendReactionCommand,
} from '../../src/application/index.js';
import { buildEndpointServer } from '../../src/presentation/mcp/server.js';
import type { AnyToolDefinition } from '../../src/presentation/mcp/registry.js';
import { buildToolDefinitions } from '../../src/presentation/mcp/tools/index.js';
import {
  buildEndpoint,
  resolvedScope,
  NO_DENIED,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from '../application/_support.js';

/**
 * Engine deps bundle: the catalogue builds every use-case from the spec tables
 * over these fakes, so a call runs the REAL resolve -> ACL -> gate pipeline; the
 * registration-only tests never execute a use-case at all (the registry reads
 * just name/requiredVerb).
 */
const engineDeps = (): WriteUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
  confirmer: new StubConfirmer(ok(true)),
  auditLog: new RecordingAuditLog(),
  clock: new FakeClock(),
});

const READ_TOOLS = [
  'get_messages',
  'search_messages',
  'list_dialogs',
  'list_topics',
  'get_chat_info',
  'get_media_info',
  'get_pinned_messages',
  'list_participants',
  'download_media',
] as const;

const WRITE_TOOLS = [
  'send_message',
  'edit_message',
  'delete_message',
  'save_draft',
  'mark_read',
  'forward_message',
  'send_reaction',
  'prepare_media',
  'send_media',
] as const;

const FORBIDDEN_NAMES = [
  'invoke',
  'raw',
  'set_scope',
  'grant',
  'revoke',
  'add_chat',
  'remove_chat',
  'set_permissions',
];

/** Register the full catalogue for an endpoint with the given verbs and return the exposed names. */
const exposedToolNames = (
  verbs: readonly PermissionVerb[],
): readonly string[] => {
  const endpoint = buildEndpoint({ verbs });
  const client = new SpyScopedClient(endpoint.name);
  const { toolNames } = buildEndpointServer({
    definitions: buildToolDefinitions(engineDeps()),
    contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
      Promise.resolve(
        ok({
          endpoint,
          resolvedScope: resolvedScope(),
          overrides: new Map(),
          deniedVerbs: NO_DENIED,
          client,
        }),
      ),
  });
  return toolNames;
};

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

describe('tool catalogue integration (STATIC menu; EXECUTION is the ACL)', () => {

  it('a READ-ONLY-everywhere endpoint LISTS the FULL catalogue (write tools included)', () => {
    const names = exposedToolNames([PermissionVerb.Read]);
    expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
    // The write tools ARE present — they deny at EXECUTION, not by omission.
    for (const write of WRITE_TOOLS) {
      expect(names).toContain(write);
    }
  });

  it('a NO-VERB endpoint ALSO lists the FULL catalogue (menu never gates)', () => {
    expect([...exposedToolNames([])].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('a KILL-SWITCHED endpoint STILL lists every tool (kill-switch is enforced at execution)', () => {
    const names = exposedToolNames([PermissionVerb.Read, PermissionVerb.Send]);
    expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
    // The send tools are NOT removed from the menu by the kill-switch.
    expect(names).toContain('send_message');
    expect(names).toContain('send_media');
  });

  it('NEVER lists a forbidden raw/scope-mutation tool name, whatever the verbs (#2)', () => {
    for (const names of [
      exposedToolNames([]),
      exposedToolNames([PermissionVerb.Read]),
      exposedToolNames([PermissionVerb.Read, PermissionVerb.Send]),
    ]) {
      for (const forbidden of FORBIDDEN_NAMES) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F9 — output contracts: every tool declares an outputSchema, the registry
// advertises it over tools/list, and a REAL result validates against it.
// ---------------------------------------------------------------------------

/** Synthetic results the scoped-client fake serves for the F9 round-trips. */
interface CannedResults {
  readonly messagePage?: Page<MessageDto>;
  readonly sendAck?: SendResultDto;
  readonly mediaFile?: MediaFileDto;
  readonly participantPage?: Page<ParticipantDto>;
  readonly reactionAck?: ReactionResultDto;
}

/**
 * SpyScopedClient with per-method synthetic values: the tool call still runs the
 * REAL spec-built pipeline (resolve -> ACL -> gate) and only the scoped port
 * answers with the fixture, so a passing round-trip proves the whole spine.
 */
class CannedScopedClient extends SpyScopedClient {
  public constructor(
    endpointName: EndpointNameValue,
    private readonly canned: CannedResults,
  ) {
    super(endpointName);
  }
  // Records the method name like the Spy base does, so tests can assert WHICH
  // scoped operation a tool reached — the assertion that pins tool->spec wiring
  // (name-level closure alone cannot catch a spec swapped between same-shaped tools).
  private canOr<T>(
    name: string,
    value: T | undefined,
    fallback: () => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    if (value !== undefined) {
      this.calls.push(name);
      return Promise.resolve(ok(value));
    }
    return fallback();
  }
  public override getMessages(
    q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.canOr('getMessages', this.canned.messagePage, () =>
      super.getMessages(q),
    );
  }
  public override searchMessages(
    q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.canOr('searchMessages', this.canned.messagePage, () =>
      super.searchMessages(q),
    );
  }
  public override getPinnedMessages(
    q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.canOr('getPinnedMessages', this.canned.messagePage, () =>
      super.getPinnedMessages(q),
    );
  }
  public override listParticipants(
    q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>> {
    return this.canOr('listParticipants', this.canned.participantPage, () =>
      super.listParticipants(q),
    );
  }
  public override downloadMedia(
    q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>> {
    return this.canOr('downloadMedia', this.canned.mediaFile, () =>
      super.downloadMedia(q),
    );
  }
  public override sendMessage(
    c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    return this.canOr('sendMessage', this.canned.sendAck, () =>
      super.sendMessage(c),
    );
  }
  public override sendReaction(
    c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>> {
    return this.canOr('sendReaction', this.canned.reactionAck, () =>
      super.sendReaction(c),
    );
  }
}

/** The in-scope chat id used by `resolvedScope()` (see tests/application/_support). */
const IN_SCOPE_CHAT = '100';

/** A rich synthetic message exercising every optional field incl. envelopes. */
const richMessage = (): MessageDto => ({
  messageId: 42,
  chatId: IN_SCOPE_CHAT,
  senderId: '777000111',
  senderDisplayName: UntrustedText.wrapSanitized(
    UntrustedTextKind.SenderDisplayName,
    'Sample Sender',
  ),
  dateIso: new Date(1_700_000_000_000).toISOString(),
  editedDateIso: new Date(1_700_000_600_000).toISOString(),
  text: UntrustedText.wrapSanitized(UntrustedTextKind.Body, 'a sample plain body'),
  replyToMessageId: 41,
  forwarded: false,
  media: {
    kind: 'document',
    mimeType: UntrustedText.wrapSanitized(
      UntrustedTextKind.MimeType,
      'application/pdf',
    ),
    sizeBytes: 2048,
    fileName: UntrustedText.wrapSanitized(
      UntrustedTextKind.Body,
      'quarterly-report.pdf',
    ),
    durationSeconds: 12,
    width: 640,
    height: 480,
  },
  reactions: [
    { emoji: 'A', count: 3 },
    { emoji: 'B', count: 1 },
  ],
});

/** A minimal synthetic message: only the required DTO fields. */
const minimalMessage = (): MessageDto => ({
  messageId: 41,
  chatId: IN_SCOPE_CHAT,
  dateIso: new Date(1_699_999_400_000).toISOString(),
  forwarded: true,
});

const syntheticPage = (): Page<MessageDto> => ({
  items: [richMessage(), minimalMessage()],
  nextCursor: 'cursor-token-1',
});

const syntheticSendAck = (): SendResultDto => ({
  chatId: IN_SCOPE_CHAT,
  messageId: 43,
  dateIso: new Date(1_700_000_900_000).toISOString(),
  idempotencyKey: 'retry-key-1',
});

const syntheticMediaFile = (): MediaFileDto => ({
  filePath: '/media/downloads/100_42_quarterly-report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  fileName: UntrustedText.wrapSanitized(
    UntrustedTextKind.Body,
    'quarterly-report.pdf',
  ),
});

const syntheticParticipantPage = (): Page<ParticipantDto> => ({
  items: [
    {
      id: '777000111',
      displayName: UntrustedText.wrapSanitized(
        UntrustedTextKind.SenderDisplayName,
        'Sample Member',
      ),
      username: 'sample_member',
      isBot: false,
    },
    {
      id: '222000333',
      displayName: UntrustedText.wrapSanitized(
        UntrustedTextKind.SenderDisplayName,
        'Helper Bot',
      ),
      isBot: true,
    },
  ],
});

const syntheticReactionAck = (): ReactionResultDto => ({
  chatId: IN_SCOPE_CHAT,
  messageId: 42,
  // A single ASCII grapheme passes the emoji schema (single grapheme cluster) and
  // keeps a literal emoji out of the source.
  emoji: 'A',
});

/** Minimal structural view of a CallToolResult — only the fields read here. */
interface ToolResultView {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

const viewResult = (result: unknown): ToolResultView => result as ToolResultView;

interface LiveCatalogue {
  readonly client: Client;
  readonly server: McpServer;
  readonly defs: readonly AnyToolDefinition[];
  readonly scoped: CannedScopedClient;
}

const openConnections: LiveCatalogue[] = [];

afterEach(async () => {
  for (const conn of openConnections.splice(0)) {
    await conn.client.close();
    await conn.server.close();
  }
});

/** Serve the REAL catalogue over the in-memory transport with canned port results. */
const openCatalogue = async (canned: CannedResults = {}): Promise<LiveCatalogue> => {
  const endpoint = buildEndpoint({
    verbs: [
      PermissionVerb.Read,
      PermissionVerb.ReadMedia,
      PermissionVerb.Send,
      PermissionVerb.React,
    ],
  });
  const scopedClient = new CannedScopedClient(endpoint.name, canned);
  const defs = buildToolDefinitions(engineDeps());
  const { server } = buildEndpointServer({
    definitions: defs,
    contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
      Promise.resolve(
        ok({
          endpoint,
          resolvedScope: resolvedScope(),
          overrides: new Map(),
          deniedVerbs: NO_DENIED,
          client: scopedClient,
        }),
      ),
  });
  const client = new Client({ name: 'catalogue-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const conn: LiveCatalogue = { client, server, defs, scoped: scopedClient };
  openConnections.push(conn);
  return conn;
};

describe('output contracts (F9): every tool declares a faithful outputSchema', () => {
  it('every catalogue definition declares a non-empty outputSchema', () => {
    for (const def of buildToolDefinitions(engineDeps())) {
      expect(
        Object.keys(def.outputSchema).length,
        `tool ${def.name} must declare its output contract`,
      ).toBeGreaterThan(0);
    }
  });

  it('tools/list ADVERTISES an object outputSchema for every tool', async () => {
    const { client } = await openCatalogue();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      expect(
        tool.outputSchema,
        `tool ${tool.name} must advertise an outputSchema`,
      ).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
    }
  });

  it('get_messages: a REAL result passes SDK validation and parses against the declared schema', async () => {
    const { client, defs, scoped } = await openCatalogue({
      messagePage: syntheticPage(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'get_messages',
        arguments: { peer: { kind: 'id', value: IN_SCOPE_CHAT } },
      }),
    );
    // A non-error result IS the proof the SDK-validated contract held.
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'getMessages']);

    // Round-trip: the DECLARED schema accepts the real presenter output verbatim.
    const def = defs.find((d) => d.name === 'get_messages');
    expect(def).toBeDefined();
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();

    // Untrusted strings arrive ONLY as named envelopes SPREAD under their key (#6) —
    // the unified snake_case shape shared with search_messages.
    const messages = res.structuredContent?.['messages'] as readonly Record<
      string,
      unknown
    >[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.['untrusted_text']).toBe('a sample plain body');
    expect(messages[0]?.['sender_display_name']).toBe('Sample Sender');
  });

  it('search_messages: emits the SANCTIONED mime_type envelope (no raw UntrustedText leak) and validates', async () => {
    const { client, defs, scoped } = await openCatalogue({
      messagePage: syntheticPage(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'search_messages',
        arguments: { query: 'sample' },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['searchMessages']);

    const def = defs.find((d) => d.name === 'search_messages');
    expect(def).toBeDefined();
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();

    // The spread envelopes surface as plain strings under their named keys —
    // NEVER as the internal { kind, sanitizedValue } representation.
    const messages = res.structuredContent?.['messages'] as readonly Record<
      string,
      unknown
    >[];
    const media = messages[0]?.['media'] as Record<string, unknown>;
    expect(media['mime_type']).toBe('application/pdf');
    expect(media['untrusted_text']).toBe('quarterly-report.pdf');
    expect(res.structuredContent?.['count']).toBe(2);
  });

  it('send_message: the CQS ack matches the shared send-ack contract exactly', async () => {
    const { client, defs, scoped } = await openCatalogue({
      sendAck: syntheticSendAck(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'send_message',
        arguments: { peer: { kind: 'me' }, text: 'a synthetic outbound line' },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'sendMessage']);

    const def = defs.find((d) => d.name === 'send_message');
    expect(def).toBeDefined();
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent).toEqual({
      chat_id: IN_SCOPE_CHAT,
      message_id: 43,
      sent_at: new Date(1_700_000_900_000).toISOString(),
      idempotency_key: 'retry-key-1',
    });
  });

  it('get_messages: REACTION tallies surface as {emoji,count} under `reactions`', async () => {
    const { client, scoped } = await openCatalogue({
      messagePage: syntheticPage(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'get_messages',
        arguments: { peer: { kind: 'id', value: IN_SCOPE_CHAT } },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'getMessages']);
    const messages = res.structuredContent?.['messages'] as readonly Record<
      string,
      unknown
    >[];
    expect(messages[0]?.['reactions']).toEqual([
      { emoji: 'A', count: 3 },
      { emoji: 'B', count: 1 },
    ]);
  });

  it('download_media: the confined file path + untrusted name validate against the declared schema', async () => {
    const { client, defs, scoped } = await openCatalogue({
      mediaFile: syntheticMediaFile(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'download_media',
        arguments: { peer: { kind: 'id', value: IN_SCOPE_CHAT }, messageId: 42 },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'downloadMedia']);

    const def = defs.find((d) => d.name === 'download_media');
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent?.['file_path']).toBe(
      '/media/downloads/100_42_quarterly-report.pdf',
    );
    expect(res.structuredContent?.['size_bytes']).toBe(2048);
    // The ORIGINAL file name arrives only under its named untrusted key.
    expect(res.structuredContent?.['untrusted_text']).toBe('quarterly-report.pdf');
  });

  it('get_pinned_messages: a REAL page validates against the declared schema', async () => {
    const { client, defs, scoped } = await openCatalogue({
      messagePage: syntheticPage(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'get_pinned_messages',
        arguments: { peer: { kind: 'id', value: IN_SCOPE_CHAT } },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'getPinnedMessages']);
    const def = defs.find((d) => d.name === 'get_pinned_messages');
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();
    expect(
      (res.structuredContent?.['messages'] as readonly unknown[]).length,
    ).toBe(2);
  });

  it('list_participants: names surface only under their untrusted key and validate', async () => {
    const { client, defs, scoped } = await openCatalogue({
      participantPage: syntheticParticipantPage(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'list_participants',
        arguments: { peer: { kind: 'id', value: IN_SCOPE_CHAT } },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'listParticipants']);
    const def = defs.find((d) => d.name === 'list_participants');
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();
    const participants = res.structuredContent?.['participants'] as readonly Record<
      string,
      unknown
    >[];
    expect(participants).toHaveLength(2);
    expect(participants[0]?.['id']).toBe('777000111');
    expect(participants[0]?.['sender_display_name']).toBe('Sample Member');
    expect(participants[0]?.['username']).toBe('sample_member');
    expect(participants[1]?.['is_bot']).toBe(true);
  });

  it('send_reaction: the ack echoes the emoji and validates against the schema', async () => {
    const { client, defs, scoped } = await openCatalogue({
      reactionAck: syntheticReactionAck(),
    });
    const res = viewResult(
      await client.callTool({
        name: 'send_reaction',
        arguments: {
          peer: { kind: 'id', value: IN_SCOPE_CHAT },
          messageId: 42,
          emoji: 'A',
        },
      }),
    );
    expect(res.isError).toBe(false);
    // Pins tool->spec WIRING: the exact scoped operation this tool must reach.
    expect(scoped.calls).toEqual(['resolvePeer', 'sendReaction']);
    const def = defs.find((d) => d.name === 'send_reaction');
    expect(() => z.object(def?.outputSchema ?? {}).parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent).toEqual({
      chat_id: IN_SCOPE_CHAT,
      message_id: 42,
      emoji: 'A',
    });
  });
});
