/**
 * Scope — the DECLARED allow-list of a virtual group as authored in config: a
 * set of chat references plus a set of folder references, still UNRESOLVED.
 * Resolution (folders -> peers, usernames -> ids) happens in infrastructure and
 * yields a `ResolvedScope` (the enforcement boundary); keeping the two types
 * distinct prevents an unresolved scope from ever being used for enforcement.
 */
import type { PeerRef } from './peer-ref.js';
import type { FolderRef } from './folder-ref.js';

export class Scope {
  public readonly chats: readonly PeerRef[];
  public readonly folders: readonly FolderRef[];

  private constructor(chats: readonly PeerRef[], folders: readonly FolderRef[]) {
    this.chats = Object.freeze([...chats]);
    this.folders = Object.freeze([...folders]);
    Object.freeze(this);
  }

  public static create(
    chats: readonly PeerRef[],
    folders: readonly FolderRef[],
  ): Scope {
    return new Scope(chats, folders);
  }
}
