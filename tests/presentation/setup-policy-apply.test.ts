/** Setup's final policy-apply boundary. No Telegram network. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EncryptedFileSessionStore,
} from '../../src/infrastructure/index.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import type { SessionKeySource } from '../../src/application/index.js';
import {
  applyConfigDraft,
  type SetupOptions,
} from '../../src/presentation/cli/setup.js';
import type { SetupUi } from '../../src/presentation/cli/ink/setup-ui-port.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';

const CHEAP = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};
const source: SessionKeySource = {
  kind: 'passphrase',
  passphrase: 'correct-pin-value',
};

const recordingUi = (notified: string[]): SetupUi =>
  ({
    notify: (line: string): void => {
      notified.push(line);
    },
    status: <T,>(_label: string, task: () => Promise<T>): Promise<T> => task(),
  }) as unknown as SetupUi;

describe('setup policy apply', () => {
  let dir: string;
  let sessionDir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-setup-apply-'));
    sessionDir = join(dir, 'sessions');
    configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        endpoints: [
          {
            name: 'reader',
            session: 'main',
            scope: { chats: ['me'], folders: [] },
            verbs: ['read'],
            tokenHash: hashEndpointToken(mintEndpointToken()),
          },
        ],
      }),
    );
    const store = new EncryptedFileSessionStore({
      directory: sessionDir,
      keySource: source,
      kdf: CHEAP,
    });
    await store.savePolicy(Buffer.from('{"version":1}', 'utf8'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const operator = (): OperatorClientPort => ({
    connect: () => Promise.resolve({ ok: true, value: undefined }),
    status: () =>
      Promise.resolve({
        ok: true,
        value: { posture: 'hardened', locked: false, hasAccounts: false },
      }),
    listAccounts: () =>
      Promise.resolve({ ok: true, value: { accounts: [] } }),
    authenticate: () => Promise.resolve({ ok: true, value: undefined }),
    applyPolicy: (raw): ReturnType<OperatorClientPort['applyPolicy']> => {
      try {
        JSON.parse(raw);
        return Promise.resolve({
          ok: true,
          value: { digest: 'a'.repeat(64) },
        });
      } catch {
        return Promise.resolve({ ok: false, error: 'config is invalid' });
      }
    },
    snapshotAccount: () => Promise.resolve({ ok: false, error: 'not used' }),
    login: () => Promise.resolve({ ok: false, error: 'not used' }),
    commitLogin: () => Promise.resolve({ ok: false, error: 'not used' }),
    cancelLogin: () => Promise.resolve({ ok: true, value: { accepted: true } }),
    removeAccount: () => Promise.resolve({ ok: true, value: { changed: true } }),
    setPin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    changePin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    removePin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    exportRecovery: (_current, _outputPath) =>
      Promise.resolve({ ok: true, value: { changed: true as const } }),
    close: () => undefined,
  });

  const options = (): SetupOptions => ({
    configPath,
    sessionDir,
    sessionKey: source,
    operatorClient: operator(),
  });

  it('returns true only after the draft is applied', async () => {
    const notified: string[] = [];

    const applied = await applyConfigDraft(
      recordingUi(notified),
      options(),
      source,
    );

    expect(applied).toBe(true);
    expect(notified.some((line) => line.startsWith('Config applied live ('))).toBe(
      true,
    );
  });

  it('returns false and reports the failure when the policy cannot be sealed', async () => {
    const notified: string[] = [];
    await writeFile(configPath, '{not-json');

    const applied = await applyConfigDraft(
      recordingUi(notified),
      options(),
      source,
    );

    expect(applied).toBe(false);
    expect(
      notified.some((line) =>
        line.startsWith('Config live apply was not confirmed:'),
      ),
    ).toBe(true);
  });
});
