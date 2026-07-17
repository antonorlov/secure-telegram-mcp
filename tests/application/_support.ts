/**
 * Shared test fixtures + in-memory port fakes for the application layer.
 * Not a *.test.ts file, so vitest imports it without running it as a suite.
 */
import { unwrap, ok, type Result } from '../../src/shared/result.js';
import {
  ChatId,
  Endpoint,
  EndpointName,
  PeerRefFactory,
  ResolvedScope,
  Scope,
  SessionRef,
  UntrustedText,
  UntrustedTextKind,
  type EndpointNameValue,
  type PeerRef,
  type PermissionVerb,
} from '../../src/domain/index.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { AuditLog, AuditRecord } from '../../src/application/ports/audit-log.js';
import type {
  RateLimiter,
  ConsumeQuotaInput,
} from '../../src/application/ports/rate-limiter.js';
import type {
  Confirmer,
  ConfirmationRequest,
} from '../../src/application/ports/confirmer.js';
import type { ScopedClient } from '../../src/application/ports/scoped-client.js';
import type { KillSwitch } from '../../src/application/ports/config-repository.js';
import type { AppError } from '../../src/application/errors.js';
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

export const chatId = (v: bigint): ChatId => unwrap(ChatId.create(v));

export const IN_SCOPE = chatId(100n);
export const OUT_OF_SCOPE = chatId(999n);
const TEST_TOKEN_HASH = `${'0'.repeat(32)}$${'0'.repeat(64)}`;

/**
 * The empty daemon-DENIED set — the default for an EndpointExecutionContext in
 * tests that do not exercise the kill-switch. Production always populates this
 * from the kill-switch (`new Set(killSwitch.disabledVerbs)` at the composition
 * site in endpoint-stack).
 */
export const NO_DENIED: ReadonlySet<PermissionVerb> = new Set<PermissionVerb>();

/** A daemon-DENIED set for the given verbs (the kill-switch at execution). */
export const deniedVerbs = (
  ...verbs: readonly PermissionVerb[]
): ReadonlySet<PermissionVerb> => new Set<PermissionVerb>(verbs);

export const buildEndpoint = (params: {
  readonly verbs: readonly PermissionVerb[];
  readonly confirmWrites?: boolean;
  readonly tokenHash?: string;
}): Endpoint =>
  Endpoint.create({
    name: unwrap(EndpointName.create('test-endpoint')),
    scope: Scope.create([PeerRefFactory.fromId(IN_SCOPE)], []),
    verbs: params.verbs,
    sessionRef: unwrap(SessionRef.create('test-session')),
    confirmWrites: params.confirmWrites ?? false,
    tokenHash: params.tokenHash ?? TEST_TOKEN_HASH,
  });

export const resolvedScope = (): ResolvedScope =>
  unwrap(ResolvedScope.create([IN_SCOPE]));

export const noKillSwitch = (): KillSwitch => ({
  disabledVerbs: new Set<PermissionVerb>(),
});

export const killSwitch = (...verbs: readonly PermissionVerb[]): KillSwitch => ({
  disabledVerbs: new Set<PermissionVerb>(verbs),
});

export class FakeClock implements Clock {
  public nowMs(): number {
    return 1_700_000_000_000;
  }
  public nowIso(): string {
    return '2023-11-14T22:13:20.000Z';
  }
}

export class RecordingAuditLog implements AuditLog {
  public readonly records: AuditRecord[] = [];
  public append(record: AuditRecord): Promise<Result<void, AppError>> {
    this.records.push(record);
    return Promise.resolve(ok(undefined));
  }
}

export class StubRateLimiter implements RateLimiter {
  public readonly calls: ConsumeQuotaInput[] = [];
  public constructor(private readonly result: Result<void, AppError>) {}
  public tryConsume(
    input: ConsumeQuotaInput,
  ): Promise<Result<void, AppError>> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

export class StubConfirmer implements Confirmer {
  public readonly calls: ConfirmationRequest[] = [];
  public constructor(private readonly result: Result<boolean, AppError>) {}
  public requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<Result<boolean, AppError>> {
    this.calls.push(request);
    return Promise.resolve(this.result);
  }
}

const untrusted = (v: string): UntrustedText =>
  UntrustedText.wrapSanitized(UntrustedTextKind.Body, v);

const SEND_RESULT: SendResultDto = {
  chatId: '100',
  messageId: 42,
  dateIso: '2023-11-14T22:13:20.000Z',
  idempotencyKey: 'gateway-minted-key',
};

const TOPIC_RESULT: TopicDto = {
  topicId: 7,
  title: UntrustedText.wrapSanitized(UntrustedTextKind.TopicTitle, 'Planning'),
  unreadCount: 3,
  closed: false,
  pinned: false,
  lastMessageId: 42,
};

/**
 * Spy ScopedClient: records every method called and returns canned Ok results.
 * Used to assert use-case ORDERING (did we even reach the writer?).
 */
export class SpyScopedClient implements ScopedClient {
  public readonly calls: string[] = [];
  public constructor(
    public readonly endpointName: EndpointNameValue,
    private readonly resolvePeerImpl?: (
      peer: PeerRef,
    ) => Result<ChatId, AppError>,
  ) {}

  private record<T>(name: string, value: T): Promise<Result<T, AppError>> {
    this.calls.push(name);
    return Promise.resolve(ok(value));
  }

  public resolvePeer(peer: PeerRef): Promise<Result<ChatId, AppError>> {
    this.calls.push('resolvePeer');
    if (this.resolvePeerImpl !== undefined) {
      return Promise.resolve(this.resolvePeerImpl(peer));
    }
    return Promise.resolve(ok(peer.kind === 'id' ? peer.id : IN_SCOPE));
  }

  public getMessages(
    _q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.record('getMessages', { items: [] });
  }
  public searchMessages(
    _q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.record('searchMessages', { items: [] });
  }
  public listDialogs(
    _q: ListDialogsQuery,
  ): Promise<Result<Page<DialogDto>, AppError>> {
    return this.record('listDialogs', { items: [] });
  }
  public listTopics(
    _q: ListTopicsQuery,
  ): Promise<Result<Page<TopicDto>, AppError>> {
    return this.record('listTopics', { items: [TOPIC_RESULT] });
  }
  public getChatInfo(
    _q: GetChatInfoQuery,
  ): Promise<Result<ChatInfoDto, AppError>> {
    return this.record('getChatInfo', {
      chatId: '100',
      title: untrusted('t'),
      kind: 'group',
      isBroadcast: false,
      isForum: false,
    });
  }
  public getMediaInfo(
    _q: GetMediaInfoQuery,
  ): Promise<Result<MediaInfoDto, AppError>> {
    return this.record('getMediaInfo', { kind: 'document' });
  }
  public downloadMedia(
    _q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>> {
    return this.record('downloadMedia', {
      filePath: '/media/downloads/100_42_document',
      mimeType: 'application/octet-stream',
      sizeBytes: 3,
    });
  }
  public getPinnedMessages(
    _q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.record('getPinnedMessages', { items: [] });
  }
  public listParticipants(
    _q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>> {
    return this.record('listParticipants', { items: [] });
  }
  public sendMessage(
    _c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    return this.record('sendMessage', SEND_RESULT);
  }
  public editMessage(
    _c: EditMessageCommand,
  ): Promise<Result<EditResultDto, AppError>> {
    return this.record('editMessage', {
      chatId: '100',
      messageId: 42,
      editedDateIso: '2023-11-14T22:13:20.000Z',
    });
  }
  public deleteMessage(
    _c: DeleteMessageCommand,
  ): Promise<Result<DeleteResultDto, AppError>> {
    return this.record('deleteMessage', {
      chatId: '100',
      deletedMessageIds: [42],
      revoked: false,
    });
  }
  public saveDraft(
    _c: SaveDraftCommand,
  ): Promise<Result<DraftResultDto, AppError>> {
    return this.record('saveDraft', { chatId: '100', saved: true });
  }
  public markRead(
    _c: MarkReadCommand,
  ): Promise<Result<MarkReadResultDto, AppError>> {
    return this.record('markRead', { chatId: '100', maxReadMessageId: 42 });
  }
  public forwardMessage(
    _c: ForwardMessageCommand,
  ): Promise<Result<ForwardResultDto, AppError>> {
    return this.record('forwardMessage', {
      fromChatId: '100',
      toChatId: '100',
      forwardedMessageIds: [42],
    });
  }
  public sendReaction(
    _c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>> {
    return this.record('sendReaction', {
      chatId: '100',
      messageId: 42,
      emoji: '+',
    });
  }
  public prepareMedia(
    _c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>> {
    return this.record('prepareMedia', {
      handle: 'h',
      expiresAtIso: '2023-11-14T22:18:20.000Z',
      sizeBytes: 1,
      mimeType: 'application/octet-stream',
    });
  }
  public sendMedia(
    _c: SendMediaCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    return this.record('sendMedia', SEND_RESULT);
  }
}
