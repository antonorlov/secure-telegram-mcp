/**
 * FolderRef — a reference to a Telegram folder (dialog filter), by numeric
 * filter id or title. An endpoint may scope an entire folder; the Telegram
 * adapter resolves it to canonical peer ids before authorization. Equality by
 * value.
 */
import { type Result, ok, err } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';

export type FolderRef =
  | { readonly kind: 'id'; readonly id: number }
  | { readonly kind: 'title'; readonly title: string };

export const FolderRefFactory = {
  fromId(id: number): Result<FolderRef, DomainError> {
    if (!Number.isInteger(id) || id < 0) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'Folder id must be a non-negative integer', {
          id,
        }),
      );
    }
    return ok(Object.freeze({ kind: 'id', id } as const));
  },

  fromTitle(raw: string): Result<FolderRef, DomainError> {
    const title = raw.trim();
    if (title.length === 0) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'Folder title must be non-empty'),
      );
    }
    return ok(Object.freeze({ kind: 'title', title } as const));
  },
} as const;
