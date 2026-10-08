// Canonical peer identity as a `bigint` — channel ids in the `-100…` space exceed
// Number.MAX_SAFE_INTEGER. GramJS peer types must never cross the infrastructure boundary.
import { type Result, ok, err, type Brand, brand } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';

export type CanonicalPeerId = Brand<bigint, 'CanonicalPeerId'>;

export class ChatId {
  private constructor(public readonly value: CanonicalPeerId) {
    Object.freeze(this);
  }

  // Rejects zero — never a valid peer.
  public static create(value: bigint): Result<ChatId, DomainError> {
    if (value === 0n) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'ChatId may not be zero'),
      );
    }
    return ok(new ChatId(brand<'CanonicalPeerId', bigint>(value)));
  }

  public static fromString(raw: string): Result<ChatId, DomainError> {
    // Bound the length before the regex and BigInt so an oversized string cannot reach
    // superlinear parse work; canonical ids are at most ~20 digits.
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

  public toKey(): string {
    return this.value.toString();
  }

  public toString(): string {
    return this.value.toString();
  }
}
