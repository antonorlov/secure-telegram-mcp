/**
 * SEALED POLICY 03 — endpoint handshake authorization uses the SEALED API-key
 * hash, so swapping the hash in the config.json draft grants nothing.
 *
 * The daemon resolves a connection to an endpoint by matching the presented API
 * key against `endpoint.tokenHash` (`resolveHandshakeEndpoint`), and those
 * endpoints come from the SEALED policy (`SealedPolicyRepository.load()`). So an
 * attacker who rewrites config.json to a hash of a token THEY hold cannot open
 * the endpoint: the loaded endpoint still carries the operator's sealed hash, and
 * the attacker's token does not match it. The operator's original token still
 * does. This closes the hash-swap escalation end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EncryptedFileSessionStore,
  type SessionKdfProfile,
} from '../../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../../src/infrastructure/config/sealed-policy-repository.js';
import { hashEndpointToken, mintEndpointToken } from '../../../src/infrastructure/endpoint-token.js';
import { resolveHandshakeEndpoint } from '../../../src/presentation/mcp/daemon.js';
import type { SessionKeySource } from '../../../src/application/index.js';
import { isOk, type Result } from '../../../src/shared/index.js';
import { applyConfigDraftForTest } from './_support.js';

const CHEAP: SessionKdfProfile = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};
const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'operator-pin' };

let dir: string;
let configPath: string;

const buildRepo = (): SealedPolicyRepository =>
  new SealedPolicyRepository({
    configPath,
    parser: new FileConfigRepository({ filePath: configPath, warn: (): void => undefined }),
    store: new EncryptedFileSessionStore({ directory: dir, keySource: PIN, kdf: CHEAP }),
    log: (): void => undefined,
  });

const expectOk = <T>(r: Result<T, unknown>): T => {
  if (!isOk(r)) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return r.value;
};

const applyDraft = (): ReturnType<typeof applyConfigDraftForTest> =>
  applyConfigDraftForTest({
    configPath,
    sessionDir: dir,
    source: PIN,
    kdf: CHEAP,
  });

const configWith = (tokenHash: string): string =>
  `${JSON.stringify(
    {
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'reader',
          session: 'main',
          tokenHash,
          scope: { chats: ['me'], folders: [2] },
          verbs: ['read'],
          hitl: { confirmWrites: true },
        },
      ],
    },
    null,
    2,
  )}\n`;

// The operator's token (sealed) and the attacker's own token (draft-swapped).
const OPERATOR_TOKEN = mintEndpointToken();
const ATTACKER_TOKEN = mintEndpointToken();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sealed03-'));
  configPath = join(dir, 'config.json');
  await writeFile(configPath, configWith(hashEndpointToken(OPERATOR_TOKEN)), { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SEALED POLICY 03: handshake authz binds to the SEALED API-key hash', () => {
  it('SANITY: the operator token resolves the endpoint from the sealed policy', async () => {
    expect(isOk(await applyDraft())).toBe(true);
    const loaded = expectOk(await buildRepo().load());
    const resolved = resolveHandshakeEndpoint(loaded.endpoints, {
      v: 1,
      token: OPERATOR_TOKEN,
    });
    expect('endpoint' in resolved).toBe(true);
  });

  it('ATTACK: swap the tokenHash in the draft to the attacker token -> attacker token still REFUSED', async () => {
    expect(isOk(await applyDraft())).toBe(true); // sealed operator hash

    // Attacker rewrites the draft so config.json holds a hash of THEIR token.
    await writeFile(configPath, configWith(hashEndpointToken(ATTACKER_TOKEN)));

    const loaded = expectOk(await buildRepo().load());
    // The sealed hash governs: the attacker's token does not resolve...
    const asAttacker = resolveHandshakeEndpoint(loaded.endpoints, {
      v: 1,
      token: ATTACKER_TOKEN,
    });
    expect('error' in asAttacker).toBe(true);
    // ...and the operator's original token still does.
    const asOperator = resolveHandshakeEndpoint(loaded.endpoints, {
      v: 1,
      token: OPERATOR_TOKEN,
    });
    expect('endpoint' in asOperator).toBe(true);
  });

  it('a token-less handshake is always refused (no keyless endpoint path)', async () => {
    expect(isOk(await applyDraft())).toBe(true);
    const loaded = expectOk(await buildRepo().load());
    const resolved = resolveHandshakeEndpoint(loaded.endpoints, { v: 1 });
    expect('error' in resolved).toBe(true);
  });
});
