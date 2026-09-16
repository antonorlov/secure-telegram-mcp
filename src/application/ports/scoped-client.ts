/**
 * Bound at construction to ONE endpoint's resolved allow-list. Every operation resolves its
 * `PeerRef` inside the client and enforces membership at the data layer, so out-of-scope peers
 * are physically unfetchable and an ungranted request returns an `AppError`, never data.
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

export interface ScopedReader {
  getMessages(q: GetMessagesQuery): Promise<Result<Page<MessageDto>, AppError>>;
  searchMessages(
    q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>>;
  listDialogs(q: ListDialogsQuery): Promise<Result<Page<DialogDto>, AppError>>;
  // Fails on non-forum chats.
  listTopics(q: ListTopicsQuery): Promise<Result<Page<TopicDto>, AppError>>;
  getChatInfo(q: GetChatInfoQuery): Promise<Result<ChatInfoDto, AppError>>;
  getMediaInfo(q: GetMediaInfoQuery): Promise<Result<MediaInfoDto, AppError>>;
  // Bytes never cross the port: the file lands on a server-generated path inside the confined
  // media root.
  downloadMedia(
    q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>>;
  getPinnedMessages(
    q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>>;
  listParticipants(
    q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>>;
}

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
  sendReaction(
    c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>>;
  // Phase 1: register a local file, returning an opaque TTL-bound handle.
  prepareMedia(
    c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>>;
  // Phase 2: send by handle — the raw path is never re-supplied.
  sendMedia(c: SendMediaCommand): Promise<Result<SendResultDto, AppError>>;
}

// Disposal is deliberately outside this port: the gateway owns client lifecycle, so a handler
// cannot retire the endpoint's shared client.
export interface ScopedClient extends ScopedReader, ScopedWriter {
  // Resolves `id` / `username` / `me` through this endpoint's bound scoped cache only — no
  // unscoped lookup, no Telegram handle exposed.
  resolvePeer(peer: PeerRef): Promise<Result<ChatId, AppError>>;
}
