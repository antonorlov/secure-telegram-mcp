/**
 * `username` and `me` stay unresolved here: resolving a username needs an unscoped resolver
 * that would escape the endpoint's scope, so resolution happens only inside the scoped data
 * layer.
 */
import { type Result, ok, err } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';
import type { ChatId } from './chat-id.js';

export type PeerRef =
  | { readonly kind: 'id'; readonly id: ChatId }
  | { readonly kind: 'username'; readonly username: string }
  | { readonly kind: 'me' };

// Telegram usernames: 5–32 chars, alnum + underscore, must start with a letter.
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export const PeerRefFactory = {
  fromId(id: ChatId): PeerRef {
    return Object.freeze({ kind: 'id', id } as const);
  },

  fromUsername(raw: string): Result<PeerRef, DomainError> {
    const username = raw.startsWith('@') ? raw.slice(1) : raw;
    if (!USERNAME_RE.test(username)) {
      return err(
        domainError(DomainErrorCode.InvalidValue, 'Invalid Telegram username', {
          raw,
        }),
      );
    }
    return ok(Object.freeze({ kind: 'username', username } as const));
  },

  me(): PeerRef {
    return Object.freeze({ kind: 'me' } as const);
  },
} as const;
