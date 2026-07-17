/**
 * SEALED POLICY 02 — a tampered / wrong-key policy blob fails closed.
 *
 * The sealed policy blob is AES-256-GCM (DEK-over-slots). Any edit to it — a
 * flipped payload authTag, a truncated ciphertext, a stripped slot, or plain
 * garbage — makes the GCM unwrap/decrypt fail, so `load()` returns a secret-free
 * Validation error and NO policy is built (fail closed). A wrong unlock secret
 * likewise cannot open it. There is no anti-rollback claim: a same-uid writer can
 * restore an OLDER sealed blob (which only reverts to a policy the operator once
 * sealed) — that is out of scope and NOT tested as a defence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EncryptedFileSessionStore,
  type SessionKdfProfile,
} from '../../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../../src/infrastructure/config/sealed-policy-repository.js';
import type { SessionKeySource } from '../../../src/application/index.js';
import { isOk, isErr } from '../../../src/shared/index.js';
import { applyConfigDraftForTest } from './_support.js';

const CHEAP: SessionKdfProfile = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};
const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'operator-pin' };
const TOKEN_HASH = `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`;
const POLICY = {
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

let dir: string;
let configPath: string;
const policyPath = (): string => join(dir, 'policy.blob');

const buildRepo = (source: SessionKeySource = PIN): SealedPolicyRepository =>
  new SealedPolicyRepository({
    configPath,
    parser: new FileConfigRepository({ filePath: configPath, warn: (): void => undefined }),
    store: new EncryptedFileSessionStore({ directory: dir, keySource: source, kdf: CHEAP }),
    log: (): void => undefined,
  });

const sealNarrow = async (): Promise<void> => {
  expect(
    isOk(
      await applyConfigDraftForTest({
        configPath,
        sessionDir: dir,
        source: PIN,
        kdf: CHEAP,
      }),
    ),
  ).toBe(true);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sealed02-'));
  configPath = join(dir, 'config.json');
  await writeFile(configPath, `${JSON.stringify(POLICY, null, 2)}\n`, { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SEALED POLICY 02: a tampered / wrong-key policy blob fails closed', () => {
  it('SANITY: the sealed policy loads cleanly under the right secret', async () => {
    await sealNarrow();
    expect(isOk(await buildRepo().load())).toBe(true);
  });

  it('flipped payload authTag -> Validation, no policy built', async () => {
    await sealNarrow();
    const blob = JSON.parse(await readFile(policyPath(), 'utf8')) as {
      payload: { authTag: string };
    };
    blob.payload.authTag = Buffer.alloc(16, 0x00).toString('base64');
    await writeFile(policyPath(), JSON.stringify(blob), 'utf8');

    const result = await buildRepo().load();
    expect(isErr(result)).toBe(true);
    expect('value' in result).toBe(false);
  });

  it('truncated ciphertext -> fails closed', async () => {
    await sealNarrow();
    const blob = JSON.parse(await readFile(policyPath(), 'utf8')) as {
      payload: { ciphertext: string };
    };
    blob.payload.ciphertext = blob.payload.ciphertext.slice(0, 8);
    await writeFile(policyPath(), JSON.stringify(blob), 'utf8');
    expect(isErr(await buildRepo().load())).toBe(true);
  });

  it('stripped slot (no slots left) -> rejected as malformed', async () => {
    await sealNarrow();
    const blob = JSON.parse(await readFile(policyPath(), 'utf8')) as {
      slots: unknown[];
    };
    blob.slots = [];
    await writeFile(policyPath(), JSON.stringify(blob), 'utf8');
    expect(isErr(await buildRepo().load())).toBe(true);
  });

  it('garbage bytes in the policy blob -> fails closed', async () => {
    await sealNarrow();
    await writeFile(policyPath(), 'not json at all', 'utf8');
    expect(isErr(await buildRepo().load())).toBe(true);
  });

  it('wrong unlock secret cannot open the policy -> fails closed', async () => {
    await sealNarrow();
    const wrong = await buildRepo({
      kind: 'passphrase',
      passphrase: 'not-the-pin',
    }).load();
    expect(isErr(wrong)).toBe(true);
    expect('value' in wrong).toBe(false);
  });
});
