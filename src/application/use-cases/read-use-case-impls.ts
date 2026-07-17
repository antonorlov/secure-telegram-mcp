/**
 * Read-tier use-case SPECS (queries; no mutation) — the single catalogue-side
 * list of what each read does. Every entry is a small spec handed to the shared
 * read engine ({@link makeReadUseCase}), which hosts the resolve -> ACL -> gate
 * -> read orchestration once. Peer hooks default to the dominant single-peer
 * shape (`[input.peer]` / `primaryKeyOf`); only `search` carries a `gate`
 * (read-side quota for the fan-out) — every other read is a free single-peer or
 * scope-wide query.
 */
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

/**
 * Typed constructor: binds a spec literal to its contract (in a form the
 * explicit-return-type lint recognizes — `satisfies` is invisible to it) and
 * FREEZES it. The engine reads authorization metadata (verb, gate) from the
 * spec reference at execute time, so an unfrozen entry could drift from the
 * verb the registry snapshot exposes.
 */
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

  /**
   * Read-side quota: one MTProto search costs one unit. An un-peered page reserves
   * its bounded worst-case fan-out; a continuation cursor advances through larger
   * scopes without one request amplifying into every chat. Keyed per session, like
   * the write buckets.
   */
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

  /**
   * Media EGRESS — its own verb (`read_media`) and the ONE read that AUDITS on
   * SUCCESS: downloading bytes to disk is a security-relevant egress, so every
   * completed download appends an allow record (endpoint + verb + target).
   */
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
