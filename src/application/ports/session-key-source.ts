/**
 * SessionKeySource — the out-of-band, operator-supplied material from which the
 * at-rest encryption key is derived. A DATA contract (primitives only); the
 * envelope/slot/KEK internals it maps to never cross this boundary. A key source
 * is NEVER taken from the model; it is supplied out-of-band (env / file / host)
 * by the operator.
 */

/** Where the secret that derives a session KEK comes from. */
export type SessionKeySource =
  /** A PIN/passphrase typed by the operator (HARDENED posture). */
  | { readonly kind: 'passphrase'; readonly passphrase: string }
  /**
   * A keyfile whose raw bytes are used as a passphrase candidate (NOT a
   * distinct slot kind — it is tried against passphrase AND recovery slots, so
   * an exported recovery keyfile unlocks through this same channel).
   */
  | { readonly kind: 'keyfile'; readonly keyfilePath: string }
  /**
   * The host machine itself (SMOOTH posture): the KEK is derived from the
   * stable, non-secret host machine id (plus each blob's own fresh salt). No
   * operator secret.
   */
  | { readonly kind: 'machine' };
