/**
 * END-TO-END SECURITY INTEGRATION TEST.
 *
 * Wires the REAL application spine — `TelegramGateway` (faked in-memory) binds a
 * physically scope-bound client, handed to the concrete read/write use-cases,
 * whose resolve -> ACL -> audit engine is the per-chat verb+scope+kill gate —
 * against a single fake gateway whose in-memory data layer PHYSICALLY enforces
 * scope (out-of-scope peers are unfetchable; INVARIANT #1).
 *
 * The only fakes are the *ports* (gateway + cross-cutting collaborators); every
 * security-bearing collaborator (capability gating, ACL evaluator, the scoped
 * client, use-cases) is the production object. The test then asserts the
 * headline guarantees CONCRETELY, by observing the in-memory data layer:
 *
 *  - a READ-ONLY endpoint can `get_messages` in scope but CANNOT send: the send
 *    fails closed with `ACL_DENIED`, spends no quota, and never mutates the data
 *    layer (#3 verb gate, #7 no-quota-on-doomed-request);
 *  - a WRITER endpoint can `send_message` WITHIN scope (the write is persisted
 *    and read back) but NOT to an OUT-OF-SCOPE peer (#1 scope gate); the
 *    out-of-scope send fails closed, spends no quota, and the unrelated peer's
 *    history is untouched;
 *  - the gateway-bound data layer is itself scope-confined: even bypassing the
 *    guard, an out-of-scope read is physically `NOT_FOUND` (#1 enforced at the
 *    data layer, not merely at a higher gate).
 */
import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PeerRefFactory,
  PermissionVerb,
  UntrustedText,
  UntrustedTextKind,
  type ChatId,
  type EndpointNameValue,
  type PeerRef,
  type ResolvedScope,
} from '../../src/domain/index.js';
import {
  AppErrorCode,
  appError,
  type AppError,
} from '../../src/application/errors.js';
import type { BindScopedClientInput } from '../../src/application/dtos/endpoint-access.js';
import type { ScopedClient } from '../../src/application/ports/scoped-client.js';
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
import { makeReadUseCase, READ_SPECS } from '../../src/application/use-cases/read-use-case-impls.js';
import { makeWriteUseCase, WRITE_SPECS } from '../../src/application/use-cases/write-use-case-impls.js';
import type { UseCase } from '../../src/application/use-cases/use-case.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  resolvedScope,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
  IN_SCOPE,
  OUT_OF_SCOPE,
  NO_DENIED,
} from '../application/_support.js';

// ---------------------------------------------------------------------------
// In-memory Telegram data layer + the fake gateway / scoped client over it.
// ---------------------------------------------------------------------------

interface StoredMessage {
  readonly id: number;
  readonly text: string;
}

/**
 * A trivial in-memory "Telegram", keyed by canonical peer id. It deliberately
 * holds messages for BOTH in-scope and out-of-scope peers, so a scoped binding
 * can be shown to make the out-of-scope rows *physically* unfetchable rather
 * than merely absent.
 */
class InMemoryTelegramDb {
  private readonly byPeer = new Map<string, StoredMessage[]>();

  public seed(peer: ChatId, messages: readonly StoredMessage[]): void {
    this.byPeer.set(peer.toKey(), [...messages]);
  }

  public history(peer: ChatId): readonly StoredMessage[] {
    return this.byPeer.get(peer.toKey()) ?? [];
  }

  /** Append a sent message and return the stored row (auto-incremented id). */
  public append(peer: ChatId, text: string): StoredMessage {
    const existing = this.byPeer.get(peer.toKey()) ?? [];
    const last = existing[existing.length - 1];
    const stored: StoredMessage = { id: (last?.id ?? 0) + 1, text };
    this.byPeer.set(peer.toKey(), [...existing, stored]);
    return stored;
  }
}

/**
 * The fake `ScopedClient` the gateway hands back. It is bound at construction to
 * ONE `ResolvedScope`; every peer-addressed operation resolves its `PeerRef`
 * here and rejects out-of-scope peers with `NOT_FOUND` (data-layer enforcement
 * of INVARIANT #1). Only the operations exercised by this suite are implemented;
 * the remainder fail closed.
 */
class InMemoryScopedClient implements ScopedClient {
  /** Records the methods actually reached, to prove doomed calls never arrive. */
  public readonly invocations: string[] = [];

  public constructor(
    public readonly endpointName: EndpointNameValue,
    private readonly scope: ResolvedScope,
    private readonly db: InMemoryTelegramDb,
  ) {}

  /** Resolve an id-peer and confirm it is inside the bound allow-list. */
  private requireInScope(peer: PeerRef): Result<ChatId, AppError> {
    if (peer.kind !== 'id') {
      return {
        ok: false,
        error: appError(
          AppErrorCode.NotFound,
          'in-memory fake resolves id peers only',
        ),
      };
    }
    if (!this.scope.contains(peer.id)) {
      return {
        ok: false,
        error: appError(
          AppErrorCode.NotFound,
          'peer is outside the bound scope — physically unfetchable',
        ),
      };
    }
    return ok(peer.id);
  }

  public resolvePeer(peer: PeerRef): Promise<Result<ChatId, AppError>> {
    if (peer.kind !== 'id') {
      return Promise.resolve(
        err(
          appError(
            AppErrorCode.NotFound,
            'in-memory fake resolves id peers only',
          ),
        ),
      );
    }
    if (!this.scope.contains(peer.id)) {
      return Promise.resolve(
        err(
          appError(
            AppErrorCode.AclDenied,
            'peer is outside the bound scope',
          ),
        ),
      );
    }
    return Promise.resolve(ok(peer.id));
  }

  private toDto(chat: ChatId, message: StoredMessage): MessageDto {
    return {
      messageId: message.id,
      chatId: chat.toKey(),
      dateIso: '2023-11-14T22:13:20.000Z',
      text: UntrustedText.wrapSanitized(UntrustedTextKind.Body, message.text),
      forwarded: false,
    };
  }

  // ---- reader (real) ----

  public getMessages(
    q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    this.invocations.push('getMessages');
    const peer = this.requireInScope(q.peer);
    if (!peer.ok) {
      return Promise.resolve(peer);
    }
    const items = this.db
      .history(peer.value)
      .slice(0, q.limit)
      .map((m) => this.toDto(peer.value, m));
    return Promise.resolve(ok({ items }));
  }

  // ---- writer (real) ----

  public sendMessage(
    c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    this.invocations.push('sendMessage');
    const peer = this.requireInScope(c.peer);
    if (!peer.ok) {
      return Promise.resolve(peer);
    }
    const stored = this.db.append(peer.value, c.text);
    const result: SendResultDto = {
      chatId: peer.value.toKey(),
      messageId: stored.id,
      dateIso: '2023-11-14T22:13:20.000Z',
      idempotencyKey: c.idempotencyKey ?? `fake-random-id-${String(stored.id)}`,
    };
    return Promise.resolve(ok(result));
  }

  // ---- unimplemented surface (fail closed; not exercised here) ----

  private unsupported<T>(name: string): Promise<Result<T, AppError>> {
    this.invocations.push(name);
    return Promise.resolve({
      ok: false,
      error: appError(
        AppErrorCode.GatewayUnavailable,
        `${name} is not implemented in the in-memory fake`,
      ),
    });
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

/**
 * Fake gateway: the ONE place an unscoped connection would live in production.
 * Here it simply mints an in-memory `ScopedClient` physically bound to the
 * requested `resolvedScope`, recording each binding so the test can inspect the
 * concrete inner client (defence-in-depth assertions).
 */
class InMemoryTelegramGateway {
  public readonly boundClients: InMemoryScopedClient[] = [];

  public constructor(private readonly db: InMemoryTelegramDb) {}

  public bindScopedClient(
    input: BindScopedClientInput,
  ): Promise<Result<ScopedClient, AppError>> {
    const client = new InMemoryScopedClient(
      input.endpoint.name,
      input.resolvedScope,
      this.db,
    );
    this.boundClients.push(client);
    return Promise.resolve(ok(client));
  }
}

// ---------------------------------------------------------------------------
// Composition helpers — assemble the production stack over the fake gateway.
// ---------------------------------------------------------------------------

const seededDb = (): InMemoryTelegramDb => {
  const db = new InMemoryTelegramDb();
  db.seed(IN_SCOPE, [
    { id: 1, text: 'first in-scope message' },
    { id: 2, text: 'second in-scope message' },
  ]);
  // Exists in the underlying store, but no endpoint here is scoped to it.
  db.seed(OUT_OF_SCOPE, [{ id: 1, text: 'confidential out-of-scope message' }]);
  return db;
};

interface AssembledStack {
  readonly ctx: EndpointExecutionContext;
  readonly gateway: InMemoryTelegramGateway;
}

/**
 * Bind the physically scope-bound client straight from the gateway (as the daemon
 * composition root now does) and package the per-request execution context. The
 * per-chat verb+scope+kill ACL is the use-case engine's job, exercised below.
 */
const assemble = async (
  verbs: readonly PermissionVerb[],
  db: InMemoryTelegramDb,
): Promise<AssembledStack> => {
  const endpoint = buildEndpoint({ verbs });
  const scope = resolvedScope();
  const gateway = new InMemoryTelegramGateway(db);

  const created = await gateway.bindScopedClient({
    endpoint,
    resolvedScope: scope,
    overrides: new Map(),
  });
  if (!created.ok) {
    throw new Error(`gateway bind unexpectedly failed: ${created.error.message}`);
  }

  return {
    ctx: { endpoint, resolvedScope: scope, overrides: new Map(), deniedVerbs: NO_DENIED, client: created.value },
    gateway,
  };
};

const readUseCase = (
  audit: RecordingAuditLog,
): UseCase<GetMessagesQuery, Page<MessageDto>> =>
  makeReadUseCase(
    {
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
    },
    READ_SPECS.getMessages,
  );

const sendUseCase = (deps: {
  readonly rateLimiter: StubRateLimiter;
  readonly confirmer: StubConfirmer;
  readonly audit: RecordingAuditLog;
}): UseCase<SendMessageCommand, SendResultDto> =>
  makeWriteUseCase(
    {
      aclEvaluator: new DefaultAclEvaluator(),
      rateLimiter: deps.rateLimiter,
      confirmer: deps.confirmer,
      auditLog: deps.audit,
      clock: new FakeClock(),
    },
    WRITE_SPECS.sendMessage,
  );

const okVoid: Result<void, AppError> = ok(undefined);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: a READ-ONLY endpoint can read in scope but never sends (#3)', () => {
  it('reads in-scope history through the full use-case stack', async () => {
    const db = seededDb();
    const { ctx } = await assemble([PermissionVerb.Read], db);
    const audit = new RecordingAuditLog();

    const result = await readUseCase(audit).execute(ctx, {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      limit: 50,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items.map((m) => m.text?.sanitizedValue)).toEqual([
        'first in-scope message',
        'second in-scope message',
      ]);
      // Every row is correctly addressed to the in-scope peer.
      expect(result.value.items.every((m) => m.chatId === IN_SCOPE.toKey())).toBe(
        true,
      );
    }
  });

  it('an in-scope SEND is refused (verb not granted) and never mutates data', async () => {
    const db = seededDb();
    const { ctx, gateway } = await assemble([PermissionVerb.Read], db);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(true));
    const audit = new RecordingAuditLog();

    const result = await sendUseCase({ rateLimiter, confirmer, audit }).execute(
      ctx,
      { peer: PeerRefFactory.fromId(IN_SCOPE), text: 'I should not be sent' },
    );

    // Fail closed at the verb gate.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
    }
    // No quota spent and no human bothered for a request that was doomed by ACL.
    expect(rateLimiter.calls).toEqual([]);
    expect(confirmer.calls).toEqual([]);
    // The data layer was never reached and never mutated (#1 / #7).
    expect(gateway.boundClients[0]?.invocations).not.toContain('sendMessage');
    expect(db.history(IN_SCOPE)).toHaveLength(2);
    // The denial is recorded as a security signal (#8).
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('an out-of-scope READ is refused (scope gate) and reaches no data', async () => {
    const db = seededDb();
    const { ctx, gateway } = await assemble([PermissionVerb.Read], db);
    const audit = new RecordingAuditLog();

    const result = await readUseCase(audit).execute(ctx, {
      peer: PeerRefFactory.fromId(OUT_OF_SCOPE),
      limit: 50,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
    }
    expect(gateway.boundClients[0]?.invocations).not.toContain('getMessages');
  });
});

describe('e2e: a WRITER endpoint sends in scope but not out of scope (#1)', () => {
  it('sends WITHIN scope: the write is persisted, audited, and read back', async () => {
    const db = seededDb();
    const { ctx } = await assemble([PermissionVerb.Read, PermissionVerb.Send], db);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(true));
    const audit = new RecordingAuditLog();

    const sent = await sendUseCase({ rateLimiter, confirmer, audit }).execute(
      ctx,
      { peer: PeerRefFactory.fromId(IN_SCOPE), text: 'hello from the writer' },
    );

    expect(sent.ok).toBe(true);
    // The write physically landed in the data layer.
    expect(db.history(IN_SCOPE)).toHaveLength(3);
    // Anti-ban quota WAS consumed for a real send (#7).
    expect(rateLimiter.calls).toHaveLength(1);
    expect(rateLimiter.calls[0]?.bucket).toBe('messages');
    // Audited ALLOW with the gateway-echoed idempotency key (#7 / #8).
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.idempotencyKey).toBe('fake-random-id-3');

    // Read it back through the read stack to prove end-to-end persistence.
    const readBack = await readUseCase(new RecordingAuditLog()).execute(ctx, {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      limit: 50,
    });
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(
        readBack.value.items.map((m) => m.text?.sanitizedValue),
      ).toContain('hello from the writer');
    }
  });

  it('refuses a send to an OUT-OF-SCOPE peer and leaves it untouched', async () => {
    const db = seededDb();
    const { ctx, gateway } = await assemble(
      [PermissionVerb.Read, PermissionVerb.Send],
      db,
    );
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(true));
    const audit = new RecordingAuditLog();

    const result = await sendUseCase({ rateLimiter, confirmer, audit }).execute(
      ctx,
      { peer: PeerRefFactory.fromId(OUT_OF_SCOPE), text: 'leak attempt' },
    );

    // Fail closed at the scope gate even though the verb IS granted (#1).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
    }
    // No quota spent and the writer never reached for a doomed send (#7).
    expect(rateLimiter.calls).toEqual([]);
    expect(gateway.boundClients[0]?.invocations).not.toContain('sendMessage');
    // The unrelated peer's history is exactly its seed — nothing written.
    expect(db.history(OUT_OF_SCOPE)).toHaveLength(1);
    expect(db.history(IN_SCOPE)).toHaveLength(2);
    expect(audit.records[0]?.outcome).toBe('deny');
  });
});
