/**
 * Endpoint API keys — mint/hash/verify SSOT. Authorization only (the PIN/app
 * key owns encryption): the config stores the SHA-256, the plaintext is shown
 * once, and verification is constant-time.
 */
import { describe, it, expect } from 'vitest';

import {
  createEndpointTokenVerifier,
  endpointTokenMatches,
} from '../../src/infrastructure/index.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';

describe('endpoint API keys', () => {
  it('mints prefixed, unique, high-entropy tokens', () => {
    const a = mintEndpointToken();
    const b = mintEndpointToken();
    expect(a).toMatch(/^tgmcp_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(a).not.toBe(b);
  });

  it('persists a SALTED digest (<salt>$<hash>) — never the plaintext, non-deterministic', () => {
    const token = mintEndpointToken();
    const a = hashEndpointToken(token);
    const b = hashEndpointToken(token);
    expect(a).toMatch(/^[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(a).not.toContain(token);
    // Fresh salt per call: the same token never hashes to the same stored value.
    expect(a).not.toBe(b);
    // ...yet both verify (the salt travels inside the stored value).
    expect(endpointTokenMatches(token, a)).toBe(true);
    expect(endpointTokenMatches(token, b)).toBe(true);
  });

  it('verifies the matching token and rejects a wrong one', () => {
    const token = mintEndpointToken();
    const hash = hashEndpointToken(token);
    expect(endpointTokenMatches(token, hash)).toBe(true);
    expect(endpointTokenMatches(mintEndpointToken(), hash)).toBe(false);
    expect(endpointTokenMatches('', hash)).toBe(false);
  });

  it('rejects malformed / unsalted stored values fail-closed (no throw)', () => {
    expect(endpointTokenMatches(mintEndpointToken(), 'deadbeef')).toBe(false); // no separator
    expect(endpointTokenMatches(mintEndpointToken(), 'ab$cd')).toBe(false); // wrong salt length
    expect(endpointTokenMatches(mintEndpointToken(), `${'a'.repeat(32)}$`)).toBe(false); // empty hash
    expect(endpointTokenMatches(mintEndpointToken(), '0'.repeat(64))).toBe(false); // legacy unsalted
  });

  it('rechecks changed policy hashes and caches only successful proofs', () => {
    const token = mintEndpointToken();
    const verify = createEndpointTokenVerifier(token);
    const first = hashEndpointToken(token);
    const rehashed = hashEndpointToken(token);
    const rotated = hashEndpointToken(mintEndpointToken());

    expect(verify(first)).toBe(true);
    expect(verify(first)).toBe(true);
    expect(verify(rehashed)).toBe(true);
    expect(verify(rotated)).toBe(false);
    expect(verify(first)).toBe(true);
  });

});
