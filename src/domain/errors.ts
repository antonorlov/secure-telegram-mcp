/** Domain errors — expected failures travel as `Result<_, DomainError>`. */

export const DomainErrorCode = {
  /** A value object factory rejected its input (malformed id, empty name, ...). */
  InvalidValue: 'INVALID_VALUE',
  /** Requested peer is not inside the endpoint's resolved allow-list. */
  PeerOutOfScope: 'PEER_OUT_OF_SCOPE',
  /** The endpoint's virtual group does not grant the requested verb. */
  VerbNotGranted: 'VERB_NOT_GRANTED',
  /** A folder-group resolved to zero peers (fail-closed; see scope-lint). */
  EmptyScope: 'EMPTY_SCOPE',
} as const;

export type DomainErrorCode =
  (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

/** Immutable description of an expected domain failure. */
export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  /** Optional structured detail — MUST NOT contain untrusted Telegram prose. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): DomainError =>
  Object.freeze(detail === undefined ? { code, message } : { code, message, detail });
