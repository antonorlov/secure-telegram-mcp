/**
 * SEALED POLICY 01 — a config.json draft edit does NOT change effective policy.
 *
 * Threat: a same-uid attacker who does NOT hold the unlock secret edits the
 * git-diffable config.json to WIDEN scope, ADD a write verb, or SWAP an endpoint
 * API-key hash, expecting the operator's next unlock to load the tampered ACL.
 * The defence: config.json is only an editable DRAFT — the runtime opens the
 * SEALED policy (AES-256-GCM, sealed under the operator slot set) and trusts only
 * that. A draft edit changes NOTHING until the operator applies it.
 *
 * We drive the REAL entry point (`SealedPolicyRepository.load()`) over a REAL
 * `EncryptedFileSessionStore` (cheap scrypt) + the REAL parser, so a "successful"
 * load builds real Endpoint/Scope domain objects — letting us assert on the
 * concrete widened scope that must never come into existence.
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
import type { SessionKeySource } from '../../../src/application/index.js';
import { PermissionVerb } from '../../../src/domain/index.js';
import { isOk, isErr, type Result } from '../../../src/shared/index.js';
import { applyConfigDraftForTest } from './_support.js';

const CHEAP: SessionKdfProfile = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};
const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'operator-pin' };
const TOKEN_HASH = `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`;

const NARROW = {
  version: 1,
  killSwitch: { disabledVerbs: [] },
  endpoints: [
    {
      name: 'reader',
      session: 'main',
      tokenHash: TOKEN_HASH,
      scope: { chats: ['me'], folders: [2] },
      verbs: ['read'],
      hitl: { confirmWrites: true },
    },
  ],
};
const WIDENED = {
  version: 1,
  killSwitch: { disabledVerbs: [] },
  endpoints: [
    {
      name: 'reader',
      session: 'main',
      tokenHash: TOKEN_HASH,
      scope: { chats: ['me', '@victim'], folders: [2, 99] },
      verbs: ['read', 'send'],
      hitl: { confirmWrites: true },
    },
  ],
};
const NARROW_JSON = `${JSON.stringify(NARROW, null, 2)}\n`;
const WIDENED_JSON = `${JSON.stringify(WIDENED, null, 2)}\n`;

let dir: string;
let configPath: string;

const buildRepo = (): SealedPolicyRepository =>
  new SealedPolicyRepository({
    configPath,
    parser: new FileConfigRepository({ filePath: configPath, warn: (): void => undefined }),
    store: new EncryptedFileSessionStore({
      directory: dir,
      keySource: PIN,
      kdf: CHEAP,
    }),
    log: (): void => undefined,
  });

const applyDraft = (): ReturnType<typeof applyConfigDraftForTest> =>
  applyConfigDraftForTest({
    configPath,
    sessionDir: dir,
    source: PIN,
    kdf: CHEAP,
  });

const expectOk = <T>(r: Result<T, unknown>): T => {
  if (!isOk(r)) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return r.value;
};

describe('SEALED POLICY 01: a config.json draft edit is ignored by the runtime', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sealed01-'));
    configPath = join(dir, 'config.json');
    await writeFile(configPath, NARROW_JSON, { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('SANITY: sealing NARROW then loading builds the narrow endpoint', async () => {
    expect(isOk(await applyDraft())).toBe(true);
    const loaded = expectOk(await buildRepo().load());
    expect(loaded.endpoints).toHaveLength(1);
    const scope = loaded.endpoints.at(0)?.scope;
    expect(scope?.chats).toHaveLength(1);
    expect(scope?.folders).toHaveLength(1);
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Read)).toBe(true);
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Send)).toBe(false);
  });

  it('CANARY: the widened JSON, if trusted, DOES build a wider endpoint (so the edit is meaningful)', () => {
    const parser = new FileConfigRepository({ filePath: configPath, warn: (): void => undefined });
    const built = expectOk(parser.loadFromParsed(WIDENED));
    const scope = built.endpoints.at(0)?.scope;
    expect(scope?.chats.length).toBe(2);
    expect(scope?.folders.length).toBe(2);
    expect(built.endpoints.at(0)?.permits(PermissionVerb.Send)).toBe(true);
  });

  it('ATTACK: widen scope + add a verb in the draft AFTER sealing -> load returns the SEALED narrow policy', async () => {
    expect(isOk(await applyDraft())).toBe(true); // sealed NARROW

    // Attacker overwrites the draft with a widened ACL. No unlock secret held,
    // so the sealed blob is untouched.
    await writeFile(configPath, WIDENED_JSON);

    const loaded = expectOk(await buildRepo().load());
    const scope = loaded.endpoints.at(0)?.scope;
    // The sealed truth still governs: one chat, one folder, read-only.
    expect(scope?.chats).toHaveLength(1);
    expect(scope?.folders).toHaveLength(1);
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Read)).toBe(true);
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Send)).toBe(false);
  });

  it('ATTACK: swap the endpoint tokenHash in the draft AFTER sealing -> load carries the SEALED hash', async () => {
    expect(isOk(await applyDraft())).toBe(true);

    const swapped = {
      ...NARROW,
      endpoints: [
        { ...NARROW.endpoints[0], tokenHash: `${'b'.repeat(32)}$${'f'.repeat(64)}` },
      ],
    };
    await writeFile(configPath, `${JSON.stringify(swapped, null, 2)}\n`);

    const loaded = expectOk(await buildRepo().load());
    expect(loaded.endpoints.at(0)?.tokenHash).toBe(TOKEN_HASH);
  });

  it('operator apply promotes the draft: afterward the widened policy loads', async () => {
    expect(isOk(await applyDraft())).toBe(true);
    await writeFile(configPath, WIDENED_JSON);
    // The operator (who holds the PIN) explicitly applies the edit.
    expect(isOk(await applyDraft())).toBe(true);

    const loaded = expectOk(await buildRepo().load());
    const scope = loaded.endpoints.at(0)?.scope;
    expect(scope?.chats).toHaveLength(2);
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Send)).toBe(true);
  });

  it('ABSENT BLOB: with no sealed policy, load() fails closed and NEVER promotes the draft', async () => {
    // No operator apply has run — the draft must stay inert.
    const first = await buildRepo().load();
    expect(isErr(first)).toBe(true);

    // load() must not have sealed anything as a side effect: a second load (and a
    // widened draft) still fail — only the explicit apply step promotes the draft.
    await writeFile(configPath, WIDENED_JSON);
    expect(isErr(await buildRepo().load())).toBe(true);

    expect(isOk(await applyDraft())).toBe(true);
    const loaded = expectOk(await buildRepo().load());
    expect(loaded.endpoints.at(0)?.permits(PermissionVerb.Send)).toBe(true);
  });

  it('ATTACK: deleting the policy blob after sealing cannot launder a widened draft into policy', async () => {
    expect(isOk(await applyDraft())).toBe(true); // sealed NARROW

    // Attacker (same uid, no unlock secret) deletes the blob and widens the draft,
    // hoping the next start or unlock promotes their draft as enforced policy.
    await rm(join(dir, 'policy.blob'), { force: true });
    await writeFile(configPath, WIDENED_JSON);

    // Fail-closed: no policy to serve, and the widened draft is NOT promoted.
    expect(isErr(await buildRepo().load())).toBe(true);
    expect(isErr(await buildRepo().load())).toBe(true);
  });

  it('a draft that does not validate is never sealed (validate-before-seal, fail-closed)', async () => {
    await writeFile(configPath, `${JSON.stringify({ version: 1, endpoints: 'nope' })}\n`);
    expect(isErr(await applyDraft())).toBe(true);
  });
});
