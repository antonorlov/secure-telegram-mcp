// Setup's final policy-apply boundary. No Telegram network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PACKAGE_VERSION } from '../../src/infrastructure/package-info.js';
import {
  EncryptedFileSessionStore,
} from '../../src/infrastructure/index.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import type { SessionKeySource } from '../../src/application/index.js';
import {
  applyConfigDraft,
  runSetup,
  type SetupOptions,
} from '../../src/presentation/cli/setup.js';
import type { ConfirmPromptRequest, PromptResult, SetupUi } from '../../src/presentation/cli/ink/setup-ui-port.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';
import { FileConfigRepository, parseConfigDocument } from '../../src/infrastructure/config/file-config-repository.js';
import { AppErrorCode, appError } from '../../src/application/index.js';
import { err, isErr, ok } from '../../src/shared/index.js';
import { MenuRecorder } from '../_support/menu-recorder.js';

const H = vi.hoisted(() => ({ ui: undefined as SetupUi | undefined }));
vi.mock('../../src/presentation/cli/ink/run-setup-app.js', () => ({
  runSetupApp: (flow: (ui: SetupUi) => Promise<void>): Promise<void> => {
    if (H.ui === undefined) throw new Error('no recorder installed');
    return flow(H.ui);
  },
}));

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
        value: {
          posture: 'hardened',
          locked: false,
          hasAccounts: false,
          version: PACKAGE_VERSION,
        },
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

  describe('setup orphan cleanup', () => {
    const stdinTty = process.stdin.isTTY;
    const stderrTty = process.stderr.isTTY;
    const exitCode = process.exitCode;
    const endpoint = (name: string, session: string): object => ({
      name, session,
      scope: { chats: ['me'], folders: [2], chatOverrides: { me: ['read', 'send'] } },
      verbs: ['read'],
      hitl: { confirmWrites: true },
      tokenHash: `${'a'.repeat(32)}$${'b'.repeat(64)}`,
    });
    const main = endpoint('reader', 'main');
    const second = endpoint('writer', 'main');
    const other = endpoint('work-reader', 'work');
    const orphan = endpoint('orphan', 'gone');
    const config = (endpoints: readonly object[]): object => ({
      version: 1, killSwitch: { disabledVerbs: ['delete'] }, maxDownloadBytes: 1024, endpoints,
    });
    let client: OperatorClientPort;
    let refs: string[];
    let events: string[];
    let applied: string | undefined;
    let diskAtApply: string | undefined;
    let stderr: string[];
    let confirms: ConfirmPromptRequest[];
    let answer: PromptResult<boolean>;

    beforeEach(async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;
      process.exitCode = undefined;
      refs = ['main', 'work'];
      events = [];
      applied = undefined;
      diskAtApply = undefined;
      stderr = [];
      confirms = [];
      answer = { kind: 'submitted', value: true };
      client = operator();
      client.status = (): ReturnType<OperatorClientPort['status']> => Promise.resolve(ok({
        posture: 'hardened', locked: false, hasAccounts: refs.length > 0, version: PACKAGE_VERSION,
      }));
      client.listAccounts = (): ReturnType<OperatorClientPort['listAccounts']> => Promise.resolve(ok({
        accounts: refs.map((sessionRef) => ({ sessionRef, label: sessionRef })),
      }));
      client.snapshotAccount = (): ReturnType<OperatorClientPort['snapshotAccount']> => Promise.resolve(ok({ chats: [], folders: [] }));
      client.applyPolicy = async (raw): ReturnType<OperatorClientPort['applyPolicy']> => {
        events.push('apply');
        diskAtApply = await readFile(configPath, 'utf8');
        const parsed = parseConfigDocument(JSON.parse(raw));
        if (isErr(parsed)) return err(parsed.error.message);
        applied = raw;
        return ok({ digest: 'a'.repeat(64) });
      };
      client.removeAccount = (ref): ReturnType<OperatorClientPort['removeAccount']> => {
        events.push(`remove:${ref}`);
        refs = refs.filter((existing) => existing !== ref);
        return Promise.resolve(ok({ changed: true }));
      };
      vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
        throw new Error(`setup exited with ${String(code)}`);
      }) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
        if (typeof chunk === 'string') stderr.push(chunk);
        return true;
      });
      await writeFile(configPath, JSON.stringify(config([main, second, other, orphan])));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      H.ui = undefined;
      process.stdin.isTTY = stdinTty;
      process.stderr.isTTY = stderrTty;
      process.exitCode = exitCode;
    });

    const drive = async (script: readonly string[]): Promise<MenuRecorder> => {
      const recorder = new MenuRecorder(script);
      H.ui = {
        ...recorder.ui,
        confirm: (request): Promise<PromptResult<boolean>> => {
          confirms.push(request);
          return Promise.resolve(answer);
        },
      };
      let crashed: unknown;
      try {
        await runSetup({ ...options(), operatorClient: client });
      } catch (error) {
        crashed = error;
      }
      if (recorder.failure !== undefined) throw recorder.failure;
      if (crashed !== undefined) throw crashed instanceof Error ? crashed : new Error(JSON.stringify(crashed));
      return recorder;
    };

    const saved = async (): Promise<unknown> => JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    const logout = ['accounts', 'logout', 'quit'];

    it('confirms the count once, saves and applies only bound endpoint removal, then removes the session', async () => {
      const recorder = await drive(logout);

      expect.soft(confirms).toEqual([{
        title: "Log out of main and remove session 'main' and 2 bound endpoint(s) from this machine?",
        defaultValue: false,
      }]);
      expect.soft(await saved()).toEqual(config([other, orphan]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
      expect.soft(diskAtApply).toBe(applied);
      expect.soft(events).toEqual(['apply', 'remove:main']);
      expect.soft(refs).toEqual(['work']);
      expect.soft(recorder.notices).toContain('Logged out of main; removed 2 bound endpoint(s).');
    });

    it.each([false, 'cancel'] as const)('leaves sessions, config and policy untouched on confirmation %s', async (choice) => {
      answer = choice === 'cancel' ? { kind: 'cancelled' } : { kind: 'submitted', value: choice };
      const before = await readFile(configPath, 'utf8');
      await drive(logout);

      expect.soft(await readFile(configPath, 'utf8')).toBe(before);
      expect.soft(events).toEqual([]);
      expect.soft(refs).toEqual(['main', 'work']);
    });

    it('applies an empty policy before removing the last account', async () => {
      refs = ['main'];
      await writeFile(configPath, JSON.stringify(config([main])));
      await drive(logout);

      expect.soft(await saved()).toEqual(config([]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
      expect.soft(events).toEqual(['apply', 'remove:main']);
      expect.soft(refs).toEqual([]);
    });

    it('stops logout on an invalid config without deleting the session', async () => {
      await writeFile(configPath, '{broken');
      const recorder = await drive(logout);

      expect.soft(confirms).toEqual([]);
      expect.soft(events).toEqual([]);
      expect.soft(await readFile(configPath, 'utf8')).toBe('{broken');
      expect.soft(recorder.notices.join('\n')).toContain('Cannot log out:');
      expect.soft(process.exitCode).toBe(1);
    });

    it('stops logout on a rejected save with config, policy and session intact', async () => {
      vi.spyOn(FileConfigRepository.prototype, 'save').mockResolvedValue(
        err(appError(AppErrorCode.Validation, 'disk full')),
      );
      const before = await readFile(configPath, 'utf8');
      const recorder = await drive(logout);

      expect.soft(await readFile(configPath, 'utf8')).toBe(before);
      expect.soft(events).toEqual([]);
      expect.soft(refs).toEqual(['main', 'work']);
      expect.soft(recorder.notices).toContain('Change NOT saved: disk full');
      expect.soft(recorder.notices).toContain("Log out stopped; session 'main' was not removed.");
      expect.soft(process.exitCode).toBe(1);
    });

    it('keeps the session and reports uncertainty when live apply fails after the save', async () => {
      vi.spyOn(client, 'applyPolicy').mockImplementation(() => {
        events.push('apply');
        return Promise.resolve(err('policy write failed'));
      });
      const recorder = await drive(logout);

      expect.soft(await saved()).toEqual(config([other, orphan]));
      expect.soft(events).toEqual(['apply']);
      expect.soft(refs).toEqual(['main', 'work']);
      expect.soft(recorder.notices).toContain('Config live apply was not confirmed: policy write failed');
      expect.soft(recorder.notices.join('\n')).toContain('Config was saved, but live apply was not confirmed');
      expect.soft(recorder.notices).toContain("Log out stopped; session 'main' was not removed.");
      expect.soft(process.exitCode).toBe(1);
    });

    it('reapplies the saved removal on retry even with zero endpoints still bound', async () => {
      const apply = client.applyPolicy;
      vi.spyOn(client, 'applyPolicy').mockImplementationOnce(() => {
        events.push('failed-apply');
        return Promise.resolve(err('policy write failed'));
      }).mockImplementation(apply);
      await drive(['accounts', 'logout', 'accounts', 'logout', 'quit']);

      expect.soft(events).toEqual(['failed-apply', 'apply', 'remove:main']);
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
      expect.soft(confirms[1]?.title).toContain('0 bound endpoint(s)');
    });

    it('reports session removal uncertainty after endpoint revocation without restoring old keys', async () => {
      vi.spyOn(client, 'removeAccount').mockImplementation((ref) => {
        events.push(`remove:${ref}`);
        return Promise.resolve(err('release failed'));
      });
      const recorder = await drive(logout);

      expect.soft(await saved()).toEqual(config([other, orphan]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
      expect.soft(events).toEqual(['apply', 'remove:main']);
      expect.soft(recorder.notices).toContain('Bound endpoints removed and applied, but session removal was not confirmed: release failed');
      expect.soft(process.exitCode).toBe(1);
    });

    it('deletes an orphan through the existing save and apply boundary, preserving other endpoints', async () => {
      await drive(['configure', 'endpoint:3', 'delete', 'back', 'quit']);

      expect.soft(await saved()).toEqual(config([main, second, other]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
      expect.soft(events).toEqual(['apply']);
    });

    it('can delete the final orphan and persist an empty policy', async () => {
      await writeFile(configPath, JSON.stringify(config([orphan])));
      await drive(['configure', 'endpoint:0', 'delete', 'back', 'quit']);

      expect.soft(await saved()).toEqual(config([]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
    });

    it('offers deletion without login when every session is missing', async () => {
      refs = [];
      await writeFile(configPath, JSON.stringify(config([orphan])));
      const recorder = await drive(['configure', 'endpoint:0', 'delete', 'back', 'quit']);

      expect.soft(recorder.at(0)?.labels).toEqual(['Remove orphaned endpoints', 'Log in', 'Quit']);
      expect.soft(recorder.at(1)?.labels).toEqual(['orphan', 'Back']);
      expect.soft(recorder.at(3)?.subtitle).toBe('0 orphaned endpoint(s) — select to delete · Back/Esc when done');
      expect.soft(await saved()).toEqual(config([]));
      expect.soft(applied).toBe(await readFile(configPath, 'utf8'));
    });

    it('restores the orphan row when its deletion cannot be saved', async () => {
      vi.spyOn(FileConfigRepository.prototype, 'save').mockResolvedValue(
        err(appError(AppErrorCode.Validation, 'disk full')),
      );
      const recorder = await drive(['configure', 'endpoint:3', 'delete', 'back', 'quit']);

      expect.soft(recorder.at(3)?.labels).toContain('orphan');
      expect.soft(await saved()).toEqual(config([main, second, other, orphan]));
      expect.soft(events).toEqual([]);
    });

    it('warns about missing sessions separately from existing endpoints in the final summary', async () => {
      await drive(['configure', 'back', 'quit']);
      const output = stderr.join('');

      expect.soft(output).toContain("Endpoints with missing sessions — delete them in Configure endpoints: orphan (session 'gone' not found)");
      expect.soft(output).toContain('Existing endpoints (keys not stored; re-create to mint): reader, writer, work-reader\n');
      expect.soft(output).toContain('Setup finished with missing-session warnings.');
      expect.soft(output).not.toContain('Setup complete.');
    });

    it('clears the deferred endpoint summary when logout changes the saved config', async () => {
      await drive(['configure', 'back', 'accounts', 'logout', 'quit']);

      expect(stderr.join('')).toBe('');
    });
  });

});
