/**
 * ChatId — the canonical Telegram peer identity (user / chat / channel), a
 * `bigint` because channel ids in the `-100…` space exceed
 * Number.MAX_SAFE_INTEGER. This is our identity type; GramJS peer types must
 * never cross the infrastructure boundary. Equality by value.
 */
import { type Result, ok, err, type Brand, brand } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';

export type CanonicalPeerId = Brand<bigint, 'CanonicalPeerId'>;

export class ChatId {
  private constructor(public readonly value: CanonicalPeerId) {
    Object.freeze(this);
  }

  /** Build from a canonical bigint id. Rejects zero (never a valid peer). */
  public static create(value: bigint): Result<ChatId, DomainError> {
    if (value === 0n) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'ChatId may not be zero'),
      );
    }
    return ok(new ChatId(brand<'CanonicalPeerId', bigint>(value)));
  }

  /** Parse a decimal string id (e.g. from config / wire). */
  public static fromString(raw: string): Result<ChatId, DomainError> {
    // Bound length BEFORE the regex/BigInt so an oversized string can't reach
    // superlinear parse work. Canonical ids are <= ~20 digits.
    if (raw.length > 32) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'ChatId string too long', {
          length: raw.length,
        }),
      );
    }
    if (!/^-?\d+$/.test(raw)) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'ChatId must be a decimal integer', {
          raw,
        }),
      );
    }
    return ChatId.create(BigInt(raw));
  }

  /** Stable string key for use in Sets/Maps (the canonical allow-list key). */
  public toKey(): string {
    return this.value.toString();
  }

  public toString(): string {
    return this.value.toString();
  }
}
