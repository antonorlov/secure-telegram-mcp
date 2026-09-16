// Input DTOs. Peer targets stay domain `PeerRef` unions that the SCOPED data layer resolves —
// never the schema layer, which preserves the scoped-client invariant.
import type { PeerRef } from '../../domain/index.js';
import type { Cursor } from './pagination.js';

// Worst-case MTProto searches one un-peered page may fan out into. The application reserves
// this cost before the adapter runs; the adapter returns a cursor when more peers remain.
export const MAX_SEARCH_FANOUT_CALLS = 8;

export interface GetMessagesQuery {
  readonly peer: PeerRef;
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  // Topic root message id; 1 = General.
  readonly topicId?: number | undefined;
}

export interface SearchMessagesQuery {
  readonly query: string;
  // Omit to fan out across the whole scope (each peer read-gated).
  readonly peer?: PeerRef | undefined;
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  // Requires `peer` — enforced at the schema and the gateway.
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

export interface DownloadMediaQuery {
  readonly peer: PeerRef;
  readonly messageId: number;
}

export interface GetPinnedQuery {
  readonly peer: PeerRef;
  readonly limit: number;
}

export interface ListParticipantsQuery {
  readonly peer: PeerRef;
  readonly limit: number;
}

export interface SendMessageCommand {
  readonly peer: PeerRef;
  readonly text: string;
  readonly replyToMessageId?: number | undefined;
  readonly topicId?: number | undefined;
  // Gateway mints one when absent.
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
  // Default false — delete only for self unless explicitly revoking.
  readonly revoke: boolean;
}

export interface SaveDraftCommand {
  readonly peer: PeerRef;
  readonly text: string;
  readonly replyToMessageId?: number | undefined;
  readonly topicId?: number | undefined;
}

export interface MarkReadCommand {
  readonly peer: PeerRef;
  // Mark read up to this id; omit to mark the whole dialog read.
  readonly maxMessageId?: number | undefined;
  // Requires `maxMessageId` — enforced at the schema and the gateway.
  readonly topicId?: number | undefined;
}

export interface ForwardMessageCommand {
  readonly fromPeer: PeerRef;
  readonly toPeer: PeerRef;
  readonly messageIds: readonly number[];
}

export interface SendReactionCommand {
  readonly peer: PeerRef;
  readonly messageId: number;
  // A single emoji grapheme (validated at the schema layer).
  readonly emoji: string;
}

export interface PrepareMediaCommand {
  readonly localPath: string;
}

// Send by handle; the raw path is never re-supplied.
export interface SendMediaCommand {
  readonly peer: PeerRef;
  readonly handle: string;
  readonly caption?: string | undefined;
  readonly topicId?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}
