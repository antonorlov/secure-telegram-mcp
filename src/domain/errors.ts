// Domain errors — expected failures travel as `Result<_, DomainError>`.

export const DomainErrorCode = {
  InvalidValue: 'INVALID_VALUE',
  PeerOutOfScope: 'PEER_OUT_OF_SCOPE',
  VerbNotGranted: 'VERB_NOT_GRANTED',
  EmptyScope: 'EMPTY_SCOPE',
} as const;

export type DomainErrorCode =
  (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  // Structured detail — MUST NOT contain untrusted Telegram prose.
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): DomainError =>
  Object.freeze(detail === undefined ? { code, message } : { code, message, detail });
