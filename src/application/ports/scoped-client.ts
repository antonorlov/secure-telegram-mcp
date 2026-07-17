/**
 * ScopedClient — the scoped-client boundary as a port.
 *
 * A ScopedClient is bound at construction to ONE endpoint's resolved allow-list
 * (chats + folder-expanded peers -> canonical ids). Every operation resolves its
 * `PeerRef` argument INSIDE the client and enforces membership at the data layer:
 * out-of-scope peers are physically unfetchable. FAIL-CLOSED — an out-of-scope or
 * ungranted request returns an `AppError`, never data.
 *
 * Split into role-specific interfaces so a use-case depends only on the narrow
 * capability it needs (the engine's specs take `ScopedReader` / `ScopedWriter`).
 * The concrete GramJS adapter implements them all; GramJS types never cross
 * this boundary. All methods return `Result<_, AppError>`.
 */
import type { Result } from '../../shared/index.js';
import type { ChatId, PeerRef } from '../../domain/index.js';
import type { AppError } from '../errors.js';
import type { Page } from '../dtos/pagination.js';
import type { MessageDto, MediaFileDto } from '../dtos/messages.js';
import type { DialogDto, ChatInfoDto, ParticipantDto } from '../dtos/dialogs.js';
import type { TopicDto } from '../dtos/topics.js';
import type { MediaInfoDto } from '../dtos/messages.js';
import type {
  SendResultDto,
  EditResultDto,
  DeleteResultDto,
  DraftResultDto,
  MarkReadResultDto,
  ForwardResultDto,
  ReactionResultDto,
  MediaHandleDto,
} from '../dtos/results.js';
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
} from '../dtos/commands.js';

/** Read-tier capabilities (queries). */
export interface ScopedReader {
  getMessages(q: GetMessagesQuery): Promise<Result<Page<MessageDto>, AppError>>;
  searchMessages(
    q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>>;
  listDialogs(q: ListDialogsQuery): Promise<Result<Page<DialogDto>, AppError>>;
  /** Enumerate forum topics of one in-scope forum supergroup (fails on non-forums). */
  listTopics(q: ListTopicsQuery): Promise<Result<Page<TopicDto>, AppError>>;
  getChatInfo(q: GetChatInfoQuery): Promise<Result<ChatInfoDto, AppError>>;
  getMediaInfo(q: GetMediaInfoQuery): Promise<Result<MediaInfoDto, AppError>>;
  /**
   * Media EGRESS (verb `read_media`): download one in-scope message's media to a
   * SERVER-GENERATED path inside the confined media root. Bytes never cross the port.
   */
  downloadMedia(
    q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>>;
  /** One page of an in-scope chat's pinned messages (read verb). */
  getPinnedMessages(
    q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>>;
  /** One page of an in-scope group/channel's participants (read verb; users fail). */
  listParticipants(
    q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>>;
}

/** Write-tier capabilities (commands), each gated by its own verb. */
export interface ScopedWriter {
  sendMessage(c: SendMessageCommand): Promise<Result<SendResultDto, AppError>>;
  editMessage(c: EditMessageCommand): Promise<Result<EditResultDto, AppError>>;
  deleteMessage(
    c: DeleteMessageCommand,
  ): Promise<Result<DeleteResultDto, AppError>>;
  saveDraft(c: SaveDraftCommand): Promise<Result<DraftResultDto, AppError>>;
  markRead(c: MarkReadCommand): Promise<Result<MarkReadResultDto, AppError>>;
  forwardMessage(
    c: ForwardMessageCommand,
  ): Promise<Result<ForwardResultDto, AppError>>;
  /** React to one in-scope message with a single emoji (verb `react`). */
  sendReaction(
    c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>>;
  /** Phase 1: register a local file, returning an opaque, TTL-bound handle. */
  prepareMedia(
    c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>>;
  /** Phase 2: send by handle only (raw path never re-supplied). */
  sendMedia(c: SendMediaCommand): Promise<Result<SendResultDto, AppError>>;
}

/**
 * The full scoped client an endpoint executes against. Lifecycle (disposal) is
 * NOT part of this port: the gateway owns and retires its concrete clients, so
 * a handler can never tear down the endpoint's shared client.
 */
export interface ScopedClient extends ScopedReader, ScopedWriter {
  /**
   * Scoped peer resolution: translate `id` / `username` / `me` to the canonical
   * chat id using ONLY this endpoint's already-bound scoped cache. Exposes no
   * Telegram input handle, performs no unscoped lookup, side-effect-free; callers
   * use the returned id for the single ACL evaluation.
   */
  resolvePeer(peer: PeerRef): Promise<Result<ChatId, AppError>>;
}
