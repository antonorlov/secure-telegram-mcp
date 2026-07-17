/**
 * Endpoint API keys — how a per-endpoint access token is minted, hashed, and
 * verified. Used by BOTH `setup` (mint + store hash) and the daemon
 * (verify), so the format lives in exactly one place.
 *
 * TWO-LAYER MODEL: the PIN/machine key ENCRYPTS the storage; the endpoint token
 * AUTHORIZES use of one endpoint. The token is therefore never key material — the
 * config stores only a SALTED hash, the plaintext is shown ONCE at mint time and
 * lives in the MCP client's config, and a leaked config reveals salted hashes only.
 *
 * Token format: `tgmcp_` + 32 random bytes base64url — prefixed so leaked tokens
 * are greppable/secret-scannable (industry practice: `sk-`, `ghp_`, …).
 *
 * Stored format: `<saltHex>$<hashHex>` where hash = SHA-256(salt ‖ token) with a
 * fresh 16-byte salt per token. The salt makes the stored value non-deterministic
 * and defeats precomputation, so a plaintext config can never be matched against a
 * rainbow table or cross-referenced across endpoints.
 *
 * WHY A FAST HASH (not scrypt/argon2): the token is 256 bits of CSPRNG entropy,
 * not a human secret — there is no feasible offline brute-force for a slow KDF to
 * slow down. Salt is the correct defense here; slowness is for low-entropy
 * passwords/PINs (where we DO use scrypt — the session-unlock KDF).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Recognisable secret-scanning prefix for endpoint API keys. */
export const ENDPOINT_TOKEN_PREFIX = 'tgmcp_';

/** The env var an MCP client supplies its endpoint API key through. */
export const ENDPOINT_TOKEN_ENV = 'TELEGRAM_MCP_ENDPOINT_TOKEN';

const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
/** Separator in the stored `<salt>$<hash>` form (‘$’ never appears in hex). */
const STORED_SEP = '$';

/** Mint a fresh endpoint API key (256-bit random, prefixed, base64url). */
export const mintEndpointToken = (): string =>
  `${ENDPOINT_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;

/** SHA-256(salt ‖ token) as hex — the inner digest of the stored form. */
const digest = (token: string, salt: Buffer): string =>
  createHash('sha256').update(salt).update(token, 'utf8').digest('hex');

/**
 * The SALTED value the config persists: `<saltHex>$<hashHex>`, with a fresh
 * random salt each call (so two identical tokens hash differently). The
 * plaintext token never lands on disk.
 */
export const hashEndpointToken = (token: string): string => {
  const salt = randomBytes(SALT_BYTES);
  return `${salt.toString('hex')}${STORED_SEP}${digest(token, salt)}`;
};

/** Constant-time verification of a presented token against a stored salted hash. */
export const endpointTokenMatches = (
  token: string,
  stored: string,
): boolean => {
  const sep = stored.indexOf(STORED_SEP);
  if (sep <= 0) {
    return false; // malformed / unsalted legacy value: fail closed
  }
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length !== SALT_BYTES || expected.length === 0) {
    return false;
  }
  const presented = Buffer.from(digest(token, salt), 'hex');
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
};

/** Cache only successful proofs for an unchanged enforced hash. */
export const createEndpointTokenVerifier = (
  token: string,
): ((stored: string) => boolean) => {
  let verifiedHash: string | undefined;
  return (stored): boolean => {
    if (stored === verifiedHash) return true;
    if (!endpointTokenMatches(token, stored)) return false;
    verifiedHash = stored;
    return true;
  };
};
