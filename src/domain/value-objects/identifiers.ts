/**
 * Slug-branded identifiers — the ONE definition of the safe-slug grammar and the
 * identities built on it:
 *
 * - EndpointName: the human-authored identity from config, constrained so it can
 *   appear in tool names, audit logs, and MCP server identifiers without escaping.
 * - SessionRef: an opaque reference to an encrypted session-at-rest. The domain
 *   knows only the NAME of the session an endpoint uses; the encrypted material
 *   and its decryption live in the encrypted session repository. The session
 *   string NEVER enters the domain.
 */
import { type Result, ok, err, type Brand, brand } from '../../shared/index.js';
import { DomainErrorCode, domainError, type DomainError } from '../errors.js';

/** lowercase letters, digits, hyphen/underscore; 1–64 chars; starts alnum. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True when `raw` satisfies the slug grammar every identifier above shares. */
export const isSlug = (raw: string): boolean => SLUG_RE.test(raw);

const makeSlug = <B extends string>(
  raw: string,
  label: string,
): Result<Brand<string, B>, DomainError> => {
  if (!isSlug(raw)) {
    return err(
      domainError(
        DomainErrorCode.InvalidValue,
        `${label} must match ${SLUG_RE.source}`,
        { raw },
      ),
    );
  }
  return ok(brand<B, string>(raw));
};

export type EndpointNameValue = Brand<string, 'EndpointName'>;

export const EndpointName = {
  create: (raw: string): Result<EndpointNameValue, DomainError> =>
    makeSlug<'EndpointName'>(raw, 'Endpoint name'),
} as const;

export type SessionRefValue = Brand<string, 'SessionRef'>;

export const SessionRef = {
  create: (raw: string): Result<SessionRefValue, DomainError> =>
    makeSlug<'SessionRef'>(raw, 'Session reference'),
} as const;
