/**
 * Forum-topic tool surface — the presentation rules the schemas cannot express:
 *
 *  - search_messages: `topicId` requires `peer` (a topic lives inside ONE chat);
 *    the handler fails fast with VALIDATION before the use-case runs.
 *  - mark_read: `topicId` requires `maxMessageId` (Telegram has no whole-topic
 *    read form); same fail-fast rule.
 *  - list_topics: emits topic rows with the untrusted `topic_title` envelope
 *    and publishes the parent chat in `enumeratedPeers` for the registry's
 *    scope re-filter.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '../../src/shared/index.js';
import {
  PermissionVerb,
  PeerRefFactory,
  UntrustedText,
  UntrustedTextKind,
} from '../../src/domain/index.js';
import {
  appError,
  AppErrorCode,
  type AppError,
  type Page,
  type MessageDto,
  type TopicDto,
  type MarkReadResultDto,
  type SearchMessagesQuery,
  type ListTopicsQuery,
  type MarkReadCommand,
} from '../../src/application/index.js';
import type { UseCase } from '../../src/application/use-cases/use-case.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import { createListTopicsTool } from '../../src/presentation/mcp/tools/listTopics.js';
import { createSearchMessagesTool } from '../../src/presentation/mcp/tools/searchMessages.js';
import { createMarkReadTool } from '../../src/presentation/mcp/tools/markRead.js';
import {
  buildEndpoint,
  resolvedScope,
  SpyScopedClient,
  IN_SCOPE,
  NO_DENIED,
} from '../application/_support.js';

const IN_SCOPE_PEER = PeerRefFactory.fromId(IN_SCOPE);

/** The full execution context a handler now receives (scoped client included). */
const execCtx = (client: SpyScopedClient): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs: [PermissionVerb.Read, PermissionVerb.MarkRead] }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: NO_DENIED,
  client,
});

/** A use-case double that records whether it was ever executed. */
class TrackingUseCase<I, O> implements UseCase<I, O> {
  public executions = 0;
  public constructor(
    public readonly verb: PermissionVerb,
    private readonly result: Result<O, AppError>,
  ) {}
  public execute(
    _ctx: EndpointExecutionContext,
    _input: I,
  ): Promise<Result<O, AppError>> {
    this.executions += 1;
    return Promise.resolve(this.result);
  }
}

describe('search_messages — topicId requires peer', () => {
  const searchUseCase = (): TrackingUseCase<SearchMessagesQuery, Page<MessageDto>> =>
    new TrackingUseCase(PermissionVerb.Read, ok({ items: [] }));

  it('fails fast with VALIDATION and never executes the use-case', async () => {
    const useCase = searchUseCase();
    const tool = createSearchMessagesTool(useCase);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      query: 'hello',
      limit: 20,
      peer: undefined,
      cursor: undefined,
      topicId: 7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.Validation);
    expect(useCase.executions).toBe(0);
  });

  it('accepts topicId together with peer', async () => {
    const useCase = searchUseCase();
    const tool = createSearchMessagesTool(useCase);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      query: 'hello',
      limit: 20,
      peer: IN_SCOPE_PEER,
      cursor: undefined,
      topicId: 7,
    });

    expect(result.ok).toBe(true);
    expect(useCase.executions).toBe(1);
  });
});

describe('mark_read — topicId requires maxMessageId', () => {
  const markReadUseCase = (): TrackingUseCase<MarkReadCommand, MarkReadResultDto> =>
    new TrackingUseCase(
      PermissionVerb.MarkRead,
      ok({ chatId: '100', maxReadMessageId: 42 }),
    );

  it('fails fast with VALIDATION and never executes the use-case', async () => {
    const useCase = markReadUseCase();
    const tool = createMarkReadTool(useCase);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      peer: IN_SCOPE_PEER,
      maxMessageId: undefined,
      topicId: 7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.Validation);
    expect(useCase.executions).toBe(0);
  });

  it('accepts topicId together with maxMessageId', async () => {
    const useCase = markReadUseCase();
    const tool = createMarkReadTool(useCase);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      peer: IN_SCOPE_PEER,
      maxMessageId: 42,
      topicId: 7,
    });

    expect(result.ok).toBe(true);
    expect(useCase.executions).toBe(1);
  });
});

describe('list_topics — structured output + enumerated parent peer', () => {
  const TOPIC: TopicDto = {
    topicId: 7,
    title: UntrustedText.wrapSanitized(UntrustedTextKind.TopicTitle, 'Planning'),
    unreadCount: 3,
    closed: false,
    pinned: true,
    lastMessageId: 42,
  };

  it('emits topic rows with the topic_title envelope and publishes the parent chat', async () => {
    const useCase = new TrackingUseCase<ListTopicsQuery, Page<TopicDto>>(
      PermissionVerb.Read,
      ok({ items: [TOPIC] }),
    );
    const tool = createListTopicsTool(useCase);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      peer: IN_SCOPE_PEER,
      limit: 20,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.structured).toEqual({
        chat_id: '100',
        topics: [
          {
            topic_id: 7,
            topic_title: 'Planning',
            unread_count: 3,
            closed: false,
            pinned: true,
            last_message_id: 42,
          },
        ],
      });
      expect(result.value.enumeratedPeers?.map((p) => p.toKey())).toEqual(['100']);
    }
    expect(tool.requiredVerb).toBe(PermissionVerb.Read);
  });

  it('propagates a use-case failure untouched (fail-closed)', async () => {
    const failing = new TrackingUseCase<ListTopicsQuery, Page<TopicDto>>(
      PermissionVerb.Read,
      err(appError(AppErrorCode.Validation, 'not a forum supergroup')),
    );
    const tool = createListTopicsTool(failing);
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);

    const result = await tool.handler(execCtx(client), {
      peer: IN_SCOPE_PEER,
      limit: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.Validation);
  });
});
