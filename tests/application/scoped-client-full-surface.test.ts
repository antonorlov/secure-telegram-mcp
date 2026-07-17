/**
 * Application-layer security guarantees, end-to-end through the USE-CASE engine
 * + registry with MOCKED/FAKED ports (no GramJS, no network). With the
 * AclGuardedScopedClient decorator removed, the per-chat verb+scope+kill ACL is
 * the use-case engine's resolve->ACL->audit path (its COMPLETENESS over every
 * tool is pinned in `sole-gate-completeness.test.ts`); this suite pins the
 * REMAINING guarantees that need a richer harness than the completeness table:
 *
 *   #1' ENUMERATOR results are RE-FILTERED (defense in depth). Even if a buggy /
 *       compromised data layer leaks an out-of-scope dialog, the registry
 *       re-verifies every enumerated peer against the resolved scope and fails
 *       the call closed.
 *   #6  Untrusted Telegram content is SANITIZED at the data layer and surfaces
 *       to the model ONLY as structured JSON under named keys (never as prose).
 *   #7  Proactive anti-ban QUOTA is enforced INDEPENDENT of FLOOD_WAIT (a
 *       quota-blocked send never reaches the writer) and IDEMPOTENT send
 *       (random_id dedup) never produces a duplicate message.
 *   prepare_media OR-gates Send over the whole scope (the per-chat-write feature).
 *
 * The real units under test are the read/write use-case orchestration, the
 * `ToolRegistry` re-filter, the real `TokenBucketRateLimiter`, and the real
 * `UnicodeSanitizer`. Only fakes/stubs cross the boundary.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PeerRefFactory,
  PermissionVerb,
  UntrustedText,
  UntrustedTextKind,
  type ChatId as ChatIdType,
  type EndpointNameValue,
  type Endpoint,
  type PeerRef,
} from '../../src/domain/index.js';
import {
  AppErrorCode,
  appError,
  type AppError,
} from '../../src/application/errors.js';
import {
  makeReadUseCase,
  READ_SPECS,
  type ReadUseCaseDeps,
} from '../../src/application/use-cases/read-use-case-impls.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
  createPrepareMediaUseCase,
} from '../../src/application/use-cases/write-use-case-impls.js';
import {
  TokenBucketRateLimiter,
  type BucketLimits,
} from '../../src/infrastructure/rate-limit/token-bucket-rate-limiter.js';
import { UnicodeSanitizer } from '../../src/infrastructure/sanitize/unicode-sanitizer.js';
import { ToolRegistry } from '../../src/presentation/mcp/registry.js';
import type { AnyToolDefinition } from '../../src/presentation/mcp/registry.js';
import { createListDialogsTool } from '../../src/presentation/mcp/tools/listDialogs.js';
import type { ScopedClient } from '../../src/application/ports/scoped-client.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import type { Page } from '../../src/application/dtos/pagination.js';
import type {
  MessageDto,
  MediaInfoDto,
  MediaFileDto,
} from '../../src/application/dtos/messages.js';
import type {
  DialogDto,
  ChatInfoDto,
  ParticipantDto,
} from '../../src/application/dtos/dialogs.js';
import type { TopicDto } from '../../src/application/dtos/topics.js';
import type {
  SendResultDto,
  EditResultDto,
  DeleteResultDto,
  DraftResultDto,
  MarkReadResultDto,
  ForwardResultDto,
  ReactionResultDto,
  MediaHandleDto,
} from '../../src/application/dtos/results.js';
import type {
  GetMessagesQuery,
  SearchMessagesQuery,
  ListDialogsQuery,
  ListTopicsQuery,
  GetChatInfoQuery,
  GetMediaInfoQuery,
  DownloadMediaQuery,
  GetPinnedQuery,
  ListParticipantsQuery,
  SendMessageCommand,
  EditMessageCommand,
  DeleteMessageCommand,
  SaveDraftCommand,
  MarkReadCommand,
  ForwardMessageCommand,
  SendReactionCommand,
  PrepareMediaCommand,
  SendMediaCommand,
} from '../../src/application/dtos/commands.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildEndpoint,
  resolvedScope,
  IN_SCOPE,
  OUT_OF_SCOPE,
  NO_DENIED,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from './_support.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ENDPOINT_NAME: EndpointNameValue = buildEndpoint({ verbs: [] }).name;

const IN_SCOPE_PEER: PeerRef = PeerRefFactory.fromId(IN_SCOPE);

const okVoid: Result<void, AppError> = ok(undefined);

const readDeps = (): ReadUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  auditLog: new RecordingAuditLog(),
  clock: new FakeClock(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
});

/**
 * A `ScopedClient` whose every method fails closed unless a subclass overrides
 * it — so a fake only implements the ONE method a test exercises, and any
 * unexpected call surfaces loudly instead of returning a silent stub value.
 */
class BaseScopedClient implements ScopedClient {
  public constructor(public readonly endpointName: EndpointNameValue) {}

  public resolvePeer(peer: PeerRef): Promise<Result<ChatIdType, AppError>> {
    const chatId = peer.kind === 'id' ? peer.id : IN_SCOPE;
    if (chatId.toKey() !== IN_SCOPE.toKey()) {
      return Promise.resolve(
        err(appError(AppErrorCode.AclDenied, 'peer is outside the bound scope')),
      );
    }
    return Promise.resolve(ok(chatId));
  }

  private unsupported<T>(method: string): Promise<Result<T, AppError>> {
    return Promise.resolve(
      err(
        appError(
          AppErrorCode.GatewayUnavailable,
          `${method} is not stubbed in this fake scoped client`,
        ),
      ),
    );
  }

  public getMessages(
    _q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.unsupported('getMessages');
  }
  public searchMessages(
    _q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.unsupported('searchMessages');
  }
  public listDialogs(
    _q: ListDialogsQuery,
  ): Promise<Result<Page<DialogDto>, AppError>> {
    return this.unsupported('listDialogs');
  }
  public listTopics(
    _q: ListTopicsQuery,
  ): Promise<Result<Page<TopicDto>, AppError>> {
    return this.unsupported('listTopics');
  }
  public getChatInfo(
    _q: GetChatInfoQuery,
  ): Promise<Result<ChatInfoDto, AppError>> {
    return this.unsupported('getChatInfo');
  }
  public getMediaInfo(
    _q: GetMediaInfoQuery,
  ): Promise<Result<MediaInfoDto, AppError>> {
    return this.unsupported('getMediaInfo');
  }
  public downloadMedia(
    _q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>> {
    return this.unsupported('downloadMedia');
  }
  public getPinnedMessages(
    _q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.unsupported('getPinnedMessages');
  }
  public listParticipants(
    _q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>> {
    return this.unsupported('listParticipants');
  }
  public sendMessage(
    _c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    return this.unsupported('sendMessage');
  }
  public editMessage(
    _c: EditMessageCommand,
  ): Promise<Result<EditResultDto, AppError>> {
    return this.unsupported('editMessage');
  }
  public deleteMessage(
    _c: DeleteMessageCommand,
  ): Promise<Result<DeleteResultDto, AppError>> {
    return this.unsupported('deleteMessage');
  }
  public saveDraft(
    _c: SaveDraftCommand,
  ): Promise<Result<DraftResultDto, AppError>> {
    return this.unsupported('saveDraft');
  }
  public markRead(
    _c: MarkReadCommand,
  ): Promise<Result<MarkReadResultDto, AppError>> {
    return this.unsupported('markRead');
  }
  public forwardMessage(
    _c: ForwardMessageCommand,
  ): Promise<Result<ForwardResultDto, AppError>> {
    return this.unsupported('forwardMessage');
  }
  public sendReaction(
    _c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>> {
    return this.unsupported('sendReaction');
  }
  public prepareMedia(
    _c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>> {
    return this.unsupported('prepareMedia');
  }
  public sendMedia(
    _c: SendMediaCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    return this.unsupported('sendMedia');
  }
}

// ===========================================================================
// #1' — ENUMERATOR results are re-filtered (defense in depth)
// ===========================================================================

/** A reader that returns the dialogs it is constructed with (may leak peers). */
class FixedDialogsClient extends BaseScopedClient {
  public constructor(
    name: EndpointNameValue,
    private readonly dialogs: readonly DialogDto[],
  ) {
    super(name);
  }
  public override listDialogs(
    _q: ListDialogsQuery,
  ): Promise<Result<Page<DialogDto>, AppError>> {
    return Promise.resolve(ok({ items: this.dialogs }));
  }
}

const dialogOf = (id: ChatIdType, title: string): DialogDto => ({
  chatId: String(id.value),
  title: UntrustedText.wrapSanitized(UntrustedTextKind.ChatTitle, title),
  kind: 'group',
  unreadCount: 0,
  pinned: false,
  isForum: false,
});

/** Minimal McpServer test double: captures each registered tool callback. */
type CapturedTool = (args: Record<string, unknown>) => Promise<CallToolResult>;

class CapturingMcpServer {
  public readonly captured = new Map<string, CapturedTool>();
  public registerTool(
    name: string,
    _config: unknown,
    cb: CapturedTool,
  ): unknown {
    this.captured.set(name, cb);
    return {};
  }
}

/**
 * Register `list_dialogs` over the given reader and invoke it through the
 * registry. The reader is handed to the handler directly as the context's
 * scoped client — the use-case gates, the registry re-filters the result.
 */
const invokeListDialogsTool = async (
  inner: ScopedClient,
): Promise<CallToolResult> => {
  const endpoint: Endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
  const scope = resolvedScope();
  const useCase = makeReadUseCase(readDeps(), READ_SPECS.listDialogs);
  const definition: AnyToolDefinition = createListDialogsTool(useCase);

  const server = new CapturingMcpServer();
  const registry = new ToolRegistry();
  const registered = registry.registerFor({
    server: server as unknown as McpServer,
    definitions: [definition],
    contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
      Promise.resolve(
        ok({
          endpoint,
          resolvedScope: scope,
          overrides: new Map(),
          deniedVerbs: NO_DENIED,
          client: inner,
        }),
      ),
  });
  expect(registered).toContain(definition.name);

  const cb = server.captured.get(definition.name);
  if (cb === undefined) {
    throw new Error('list_dialogs tool was not registered');
  }
  return cb({ limit: 50 });
};

/** Pull `{ code }` out of an isError tool result without using `any`. */
const errorCodeOf = (result: CallToolResult): string | undefined => {
  const block = result.content[0];
  if (block?.type !== 'text') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(block.text);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'error' in parsed &&
    typeof parsed.error === 'object' &&
    parsed.error !== null &&
    'code' in parsed.error &&
    typeof parsed.error.code === 'string'
  ) {
    return parsed.error.code;
  }
  return undefined;
};

describe("#1' enumerator results are re-filtered against the resolved scope", () => {
  it('fails CLOSED when the data layer leaks an out-of-scope dialog', async () => {
    const leaky = new FixedDialogsClient(SAMPLE_ENDPOINT_NAME, [
      dialogOf(IN_SCOPE, 'in scope'),
      dialogOf(OUT_OF_SCOPE, 'LEAKED out of scope'),
    ]);

    const result = await invokeListDialogsTool(leaky);

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe(AppErrorCode.AclDenied);
  });

  it('passes when every enumerated dialog is in scope, emitting structured titles', async () => {
    const clean = new FixedDialogsClient(SAMPLE_ENDPOINT_NAME, [
      dialogOf(IN_SCOPE, 'general'),
    ]);

    const result = await invokeListDialogsTool(clean);

    expect(result.isError).toBe(false);
    const dialogs = result.structuredContent?.['dialogs'];
    expect(Array.isArray(dialogs)).toBe(true);
    if (Array.isArray(dialogs)) {
      expect(dialogs).toHaveLength(1);
      const first: unknown = dialogs[0];
      // Untrusted title surfaced ONLY under its named key (#6), never as prose.
      expect(
        typeof first === 'object' && first !== null && 'chat_title' in first,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// #6 — untrusted content is sanitized and emitted as structured JSON
// ===========================================================================

/** A reader that returns one message carrying pre-sanitized untrusted fields. */
class OneMessageClient extends BaseScopedClient {
  public constructor(
    name: EndpointNameValue,
    private readonly message: MessageDto,
  ) {
    super(name);
  }
  public override getMessages(
    _q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return Promise.resolve(ok({ items: [this.message] }));
  }
}

describe('#6 untrusted Telegram content is sanitized at the data layer', () => {
  it('strips zero-width/bidi/BOM/control chars, NFC-normalizes, and keys the output', async () => {
    const sanitizer = new UnicodeSanitizer();

    // Raw, attacker-controlled string mixing: ZWSP (U+200B), RLO bidi override
    // (U+202E), 'd', a DECOMPOSED 'e'+combining-acute (U+0065 U+0301) that NFC
    // folds to 'é' (U+00E9), a BEL control (U+0007), preserved \n and \t, and a
    // trailing BOM (U+FEFF). Explicit escapes -> no invisible code points in the
    // source, and a fully deterministic expected value.
    const rawBody = 'A\u200B\u202Ed\u0065\u0301\u0007\nB\tC\uFEFF';
    const body = sanitizer.sanitize(UntrustedTextKind.Body, rawBody);
    const sender = sanitizer.sanitize(
      UntrustedTextKind.SenderDisplayName,
      '\u202Eevil\u200B',
    );

    const message: MessageDto = {
      messageId: 7,
      chatId: String(IN_SCOPE.value),
      dateIso: '2023-11-14T22:13:20.000Z',
      forwarded: false,
      text: body,
      senderDisplayName: sender,
    };

    const inner = new OneMessageClient(SAMPLE_ENDPOINT_NAME, message);
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
    const useCase = makeReadUseCase(readDeps(), READ_SPECS.getMessages);

    const result = await useCase.execute(
      { endpoint, resolvedScope: resolvedScope(), overrides: new Map(), deniedVerbs: NO_DENIED, client: inner },
      { peer: IN_SCOPE_PEER, limit: 10 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const read = result.value.items[0];
    expect(read).toBeDefined();
    if (read === undefined) return;

    // Body: emitted as structured JSON under `untrusted_text`, fully cleaned.
    expect(read.text).toBeDefined();
    if (read.text !== undefined) {
      const structured = read.text.toStructured();
      expect(structured).toEqual({ untrusted_text: 'Ad\u00E9\nB\tC' });
      const clean = structured[UntrustedTextKind.Body];
      for (const dangerous of ['\u200B', '\u202E', '\u0007', '\uFEFF']) {
        expect(clean.includes(dangerous)).toBe(false);
      }
      // NFC folded the decomposed sequence; legible whitespace is preserved.
      expect(clean.includes('\u00E9')).toBe(true);
      expect(clean.includes('\n')).toBe(true);
      expect(clean.includes('\t')).toBe(true);
    }

    // Sender name surfaces ONLY under its own named key (#9 ID-primary, #6).
    expect(read.senderDisplayName).toBeDefined();
    if (read.senderDisplayName !== undefined) {
      expect(Object.keys(read.senderDisplayName.toStructured())).toEqual([
        UntrustedTextKind.SenderDisplayName,
      ]);
    }
  });
});

// ===========================================================================
// #7 — proactive anti-ban quota + idempotent send
// ===========================================================================

describe('#7 proactive anti-ban quota is enforced independent of FLOOD_WAIT', () => {
  it('blocks the over-quota send BEFORE it can reach the gateway writer', async () => {
    const clock = new FakeClock(); // fixed time -> no refill between calls
    const limits: BucketLimits = {
      messagesPerMin: 2,
      forwardsPerMin: 5,
      searchesPerMin: 5,
    };
    const rateLimiter = new TokenBucketRateLimiter(clock, limits);
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Send] });
    const inner = new SpyScopedClient(endpoint.name);
    const useCase = makeWriteUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      rateLimiter,
      confirmer: new StubConfirmer(ok(true)),
      auditLog: new RecordingAuditLog(),
      clock,
    }, WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint,
      resolvedScope: resolvedScope(),
      overrides: new Map(),
      deniedVerbs: NO_DENIED,
      client: inner,
    };
    const command: SendMessageCommand = { peer: IN_SCOPE_PEER, text: 'hi' };

    const first = await useCase.execute(ctx, command);
    const second = await useCase.execute(ctx, command);
    const third = await useCase.execute(ctx, command);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.code).toBe(AppErrorCode.QuotaExceeded);
      expect(third.error.retryAfterSeconds).toBeGreaterThan(0);
    }
    // Exactly the two within-quota sends reached the writer; the third did not.
    expect(inner.calls).toEqual([
      'resolvePeer',
      'sendMessage',
      'resolvePeer',
      'sendMessage',
      'resolvePeer',
    ]);
  });
});

/** A gateway-like client that dedups sends by idempotency key (random_id, #7). */
class IdempotentSendClient extends BaseScopedClient {
  public appendedCount = 0;
  public dedupHits = 0;
  public readonly received: SendMessageCommand[] = [];
  private readonly store = new Map<string, SendResultDto>();
  private nextId = 5000;

  public override sendMessage(
    c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    this.received.push(c);
    const key = c.idempotencyKey ?? `minted-${String(this.nextId)}`;
    const existing = this.store.get(key);
    if (existing !== undefined) {
      this.dedupHits += 1;
      return Promise.resolve(ok(existing));
    }
    const messageId = this.nextId;
    this.nextId += 1;
    this.appendedCount += 1;
    const result: SendResultDto = {
      chatId: String(IN_SCOPE.value),
      messageId,
      dateIso: '2023-11-14T22:13:20.000Z',
      idempotencyKey: key,
    };
    this.store.set(key, result);
    return Promise.resolve(ok(result));
  }
}

describe('#7 idempotent send: a repeated random_id never produces a duplicate', () => {
  it('dedups two identical sends to ONE message and echoes/audits the key', async () => {
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Send] });
    const inner = new IdempotentSendClient(endpoint.name);
    const audit = new RecordingAuditLog();
    const useCase = makeWriteUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      rateLimiter: new StubRateLimiter(okVoid),
      confirmer: new StubConfirmer(ok(true)),
      auditLog: audit,
      clock: new FakeClock(),
    }, WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint,
      resolvedScope: resolvedScope(),
      overrides: new Map(),
      deniedVerbs: NO_DENIED,
      client: inner,
    };
    const command: SendMessageCommand = {
      peer: IN_SCOPE_PEER,
      text: 'hi',
      idempotencyKey: 'abc',
    };

    const first = await useCase.execute(ctx, command);
    const second = await useCase.execute(ctx, command);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // The duplicate was deduped: only ONE underlying message was created.
    expect(inner.appendedCount).toBe(1);
    expect(inner.dedupHits).toBe(1);

    if (first.ok && second.ok) {
      expect(first.value.messageId).toBe(second.value.messageId);
      expect(first.value.idempotencyKey).toBe('abc');
      expect(second.value.idempotencyKey).toBe('abc');
    }

    // The caller's key flowed through to the writer (#7).
    expect(inner.received.map((c) => c.idempotencyKey)).toEqual(['abc', 'abc']);

    // Both writes are audited with the echoed idempotency key (traceability #8).
    expect(audit.records).toHaveLength(2);
    expect(
      audit.records.every(
        (record) =>
          record.outcome === 'allow' && record.idempotencyKey === 'abc',
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// prepare_media is peer-less: it gates on "Send reachable on ANY in-scope chat"
// (group grant ∪ any per-chat Send override), so a read-only-GROUP endpoint that
// carries a per-chat Send override can still prepare media for its writable chat.
// The concrete send_media re-gates the specific target per-chat, so this coarser
// OR-gate widens nothing at dispatch. (Regression guard for the media asymmetry.)
// ===========================================================================

class PrepareOnlyClient extends BaseScopedClient {
  public prepared = 0;
  public override prepareMedia(
    _c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>> {
    this.prepared += 1;
    return Promise.resolve(
      ok({
        handle: 'h',
        expiresAtIso: '2023-11-14T22:18:20.000Z',
        sizeBytes: 1,
        mimeType: 'application/octet-stream',
      }),
    );
  }
}

const PREPARE_CMD: PrepareMediaCommand = { localPath: '/tmp/x.bin' };

const runPrepare = (
  overrides: ReadonlyMap<string, ReadonlySet<PermissionVerb>>,
  denied: ReadonlySet<PermissionVerb>,
  inner: PrepareOnlyClient,
): Promise<Result<MediaHandleDto, AppError>> =>
  createPrepareMediaUseCase(readDeps()).execute(
    {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
      resolvedScope: resolvedScope(),
      overrides,
      deniedVerbs: denied,
      client: inner,
    },
    PREPARE_CMD,
  );

describe('prepare_media OR-gates Send over the whole scope (per-chat-write feature)', () => {
  it('ALLOWS prepare_media when a per-chat Send override exists on a read-only group', async () => {
    const inner = new PrepareOnlyClient(SAMPLE_ENDPOINT_NAME);
    const result = await runPrepare(
      new Map([[IN_SCOPE.toKey(), new Set([PermissionVerb.Send])]]),
      NO_DENIED,
      inner,
    );

    expect(result.ok).toBe(true);
    expect(inner.prepared).toBe(1);
  });

  it('DENIES prepare_media on a read-only-everywhere endpoint (no chat can send)', async () => {
    const inner = new PrepareOnlyClient(SAMPLE_ENDPOINT_NAME);
    const result = await runPrepare(new Map(), NO_DENIED, inner);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(inner.prepared).toBe(0); // fail-closed: never reached the gateway
  });

  it('DENIES prepare_media when the kill-switch denies Send even with an override', async () => {
    const inner = new PrepareOnlyClient(SAMPLE_ENDPOINT_NAME);
    const result = await runPrepare(
      new Map([[IN_SCOPE.toKey(), new Set([PermissionVerb.Send])]]),
      new Set([PermissionVerb.Send]),
      inner,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(inner.prepared).toBe(0);
  });
});
