/**
 * The canonical allow-list used for enforcement: the data layer binds a client to exactly this
 * set, so out-of-scope peers are physically unfetchable. FAIL-CLOSED — construction rejects an
 * empty set, since a folder that resolved to zero peers is a config error, never allow-all.
 */
import { type Result, ok, err } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';
import type { ChatId } from './chat-id.js';

export class ResolvedScope {
  private readonly members: ReadonlyMap<string, ChatId>;

  private constructor(members: ReadonlyMap<string, ChatId>) {
    this.members = members;
    Object.freeze(this);
  }

  public static create(
    peers: readonly ChatId[],
  ): Result<ResolvedScope, DomainError> {
    if (peers.length === 0) {
      return err(
        domainError(
          DomainErrorCode.EmptyScope,
          'Resolved scope is empty — refusing to build an allow-all client (fail-closed)',
        ),
      );
    }
    const members = new Map<string, ChatId>();
    for (const peer of peers) {
      members.set(peer.toKey(), peer);
    }
    return ok(new ResolvedScope(members));
  }

  public contains(peer: ChatId): boolean {
    return this.members.has(peer.toKey());
  }

  public get size(): number {
    return this.members.size;
  }

  public toArray(): readonly ChatId[] {
    return Object.freeze([...this.members.values()]);
  }
}
