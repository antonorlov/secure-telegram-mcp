/**
 * ResolvedScope — the canonical allow-list used for enforcement. The data layer
 * builds a client bound to exactly this set of peer ids so out-of-scope peers
 * are physically unfetchable; `contains` is the single membership test the ACL
 * service and scoped client share. FAIL-CLOSED: construction rejects an empty
 * set (a folder-group that resolved to 0 peers is a config error, never
 * allow-all). Membership keyed by canonical id string.
 */
import { type Result, ok, err } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';
import type { ChatId } from './chat-id.js';

export class ResolvedScope {
  /** canonical-id-string -> ChatId. */
  private readonly members: ReadonlyMap<string, ChatId>;

  private constructor(members: ReadonlyMap<string, ChatId>) {
    this.members = members;
    Object.freeze(this);
  }

  /** Build from the fully-resolved peer ids. FAIL-CLOSED on empty input. */
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

  /** The single membership test for enforcement. */
  public contains(peer: ChatId): boolean {
    return this.members.has(peer.toKey());
  }

  public get size(): number {
    return this.members.size;
  }

  /** Immutable snapshot of the allow-list (for building the scoped client). */
  public toArray(): readonly ChatId[] {
    return Object.freeze([...this.members.values()]);
  }
}
