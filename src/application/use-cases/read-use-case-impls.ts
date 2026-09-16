// Read-tier specs; the shared engine hosts resolve -> ACL -> gate -> read. Peer hooks default
// to the single-peer shape, and only `search` carries a gate.
import { PermissionVerb } from '../../domain/index.js';
import type { Page } from '../dtos/pagination.js';
import type {
  MessageDto,
  MediaInfoDto,
  MediaFileDto,
} from '../dtos/messages.js';
import type { DialogDto, ChatInfoDto, ParticipantDto } from '../dtos/dialogs.js';
import type { TopicDto } from '../dtos/topics.js';
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
} from '../dtos/commands.js';
import { MAX_SEARCH_FANOUT_CALLS } from '../dtos/commands.js';
import { primaryKeyOf } from './use-case-support.js';
import type {
  ReadSpec,
} from './use-case-engine.js';

export { makeReadUseCase } from './use-case-engine.js';
export type { ReadUseCaseDeps } from './use-case-engine.js';

// Freezes each spec: the engine reads verb and gate from the spec reference at execute time, so
// an unfrozen entry could drift from the verb the registry snapshot exposes.
const readSpec = <TInput, TOutput>(
  spec: ReadSpec<TInput, TOutput>,
): ReadSpec<TInput, TOutput> => {
  Object.freeze(spec);
  return spec;
};

export const READ_SPECS = Object.freeze({
  getMessages: readSpec<GetMessagesQuery, Page<MessageDto>>({
    run: (reader, input) => reader.getMessages(input),
  }),

  // Read-side quota: one MTProto search costs one unit, and an un-peered page reserves its
  // bounded worst-case fan-out.
  searchMessages: readSpec<SearchMessagesQuery, Page<MessageDto>>({
    peers: (input) => (input.peer === undefined ? [] : [input.peer]),
    targetKey: (input) => primaryKeyOf(input.peer),
    gate: (ctx, input, deps) =>
      deps.rateLimiter.tryConsume({
        sessionRef: ctx.endpoint.sessionRef,
        endpointName: ctx.endpoint.name,
        bucket: 'searches',
        units:
          input.peer === undefined
            ? Math.min(ctx.resolvedScope.size, MAX_SEARCH_FANOUT_CALLS)
            : 1,
      }),
    run: (reader, input) => reader.searchMessages(input),
  }),

  listDialogs: readSpec<ListDialogsQuery, Page<DialogDto>>({
    peers: () => [],
    targetKey: () => undefined,
    run: (reader, input) => reader.listDialogs(input),
  }),

  listTopics: readSpec<ListTopicsQuery, Page<TopicDto>>({
    run: (reader, input) => reader.listTopics(input),
  }),

  getChatInfo: readSpec<GetChatInfoQuery, ChatInfoDto>({
    run: (reader, input) => reader.getChatInfo(input),
  }),

  getMediaInfo: readSpec<GetMediaInfoQuery, MediaInfoDto>({
    run: (reader, input) => reader.getMediaInfo(input),
  }),

  // Media egress is the one read that audits on SUCCESS — downloading bytes to disk is a
  // security-relevant egress.
  downloadMedia: readSpec<DownloadMediaQuery, MediaFileDto>({
    verb: PermissionVerb.ReadMedia,
    auditSuccess: true,
    run: (reader, input) => reader.downloadMedia(input),
  }),

  getPinnedMessages: readSpec<GetPinnedQuery, Page<MessageDto>>({
    run: (reader, input) => reader.getPinnedMessages(input),
  }),

  listParticipants: readSpec<ListParticipantsQuery, Page<ParticipantDto>>({
    run: (reader, input) => reader.listParticipants(input),
  }),
});
