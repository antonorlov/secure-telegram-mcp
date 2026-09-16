// The DECLARED allow-list, still unresolved. Keeping it distinct from `ResolvedScope` prevents
// an unresolved scope from ever being used for enforcement.
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
