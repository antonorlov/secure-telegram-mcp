/**
 * Input command/query DTOs for the use-cases. Peer targets are domain `PeerRef`
 * unions (id | username | me) that the SCOPED data layer resolves — never the
 * schema layer (preserves the scoped-client invariant). Message ids are raw
 * numbers throughout.
 */
import type { PeerRef } from '../../domain/index.js';
import type { Cursor } from './pagination.js';

// ---- queries (read tier) ----

/**
 * Maximum MTProto searches one un-peered search page may fan out into. The
 * application reserves this worst-case cost before the adapter runs, and the
 * adapter returns a continuation cursor when more peers remain.
 */
export const MAX_SEARCH_FANOUT_CALLS = 8;

export interface GetMessagesQuery {
  readonly peer: PeerRef;
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  /** Restrict to one forum topic (topic root message id; 1 = General). */
  readonly topicId?: number | undefined;
}

export interface SearchMessagesQuery {
  readonly query: string;
  /** Omit to fan out across the whole scope (each peer read-gated). */
  readonly peer?: PeerRef | undefined;
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  /** Restrict to one forum topic; requires `peer` (enforced at schema + gateway). */
  readonly topicId?: number | undefined;
}

export interface ListTopicsQuery {
  readonly peer: PeerRef;
  readonly limit: number;
}

export interface ListDialogsQuery {
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
}

export interface GetChatInfoQuery {
  readonly peer: PeerRef;
}

export interface GetMediaInfoQuery {
  readonly peer: PeerRef;
  readonly messageId: number;
}

/** Media EGRESS: download one in-scope message's media (verb `read_media`). */
export interface DownloadMediaQuery {
  readonly peer: PeerRef;
  readonly messageId: number;
}

/** One page of a chat's PINNED messages (read verb). */
export interface GetPinnedQuery {
  readonly peer: PeerRef;
  readonly limit: number;
}

/** One page of a group/channel's participants (read verb). */
export interface ListParticipantsQuery {
  readonly peer: PeerRef;
  readonly limit: number;
}

// ---- commands (write tier) ----

export interface SendMessageCommand {
  readonly peer: PeerRef;
  readonly text: string;
  readonly replyToMessageId?: number | undefined;
  /** Post into this forum topic (topic root message id; 1 = General). */
  readonly topicId?: number | undefined;
  /** Optional caller-supplied idempotency key; gateway mints one if absent. */
  readonly idempotencyKey?: string | undefined;
}

export interface EditMessageCommand {
  readonly peer: PeerRef;
  readonly messageId: number;
  readonly text: string;
}

export interface DeleteMessageCommand {
  readonly peer: PeerRef;
  readonly messageIds: readonly number[];
  /** Default false — delete only for self unless explicitly revoking. */
  readonly revoke: boolean;
}

export interface SaveDraftCommand {
  readonly peer: PeerRef;
  readonly text: string;
  readonly replyToMessageId?: number | undefined;
  /** Address the draft to this forum topic (topic root message id; 1 = General). */
  readonly topicId?: number | undefined;
}

export interface MarkReadCommand {
  readonly peer: PeerRef;
  /** Mark read up to this id; omit to mark the whole dialog read. */
  readonly maxMessageId?: number | undefined;
  /** Mark one forum topic read; requires `maxMessageId` (enforced at schema + gateway). */
  readonly topicId?: number | undefined;
}

export interface ForwardMessageCommand {
  readonly fromPeer: PeerRef;
  readonly toPeer: PeerRef;
  readonly messageIds: readonly number[];
}

/** React to one in-scope message with a single emoji (verb `react`). */
export interface SendReactionCommand {
  readonly peer: PeerRef;
  readonly messageId: number;
  /** A single emoji grapheme (validated at the schema layer). */
  readonly emoji: string;
}

/** Phase 1 of two-phase media send: register a local file, get an opaque handle. */
export interface PrepareMediaCommand {
  readonly localPath: string;
}

/** Phase 2: send previously-prepared media by handle (raw path never re-supplied). */
export interface SendMediaCommand {
  readonly peer: PeerRef;
  readonly handle: string;
  readonly caption?: string | undefined;
  /** Post into this forum topic (topic root message id; 1 = General). */
  readonly topicId?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}
