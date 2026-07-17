/**
 * setup — the NON-TTY / `--no-input` / CI branch (the ISATTY guard, decided ONCE
 * at entry). This branch is the automation-and-security contract: setup is
 * interactive by nature (it logs in and reads a PIN and NEVER reads secrets from
 * a pipe), so on a non-terminal it MUST NOT block on stdin. Instead it:
 *
 *   1. prints the CURRENT config (endpoints + scope/verbs summary) to STDERR, and
 *   2. exits NON-ZERO,
 *
 * WITHOUT loading the interactive Ink app or touching the daemon operator, and
 * WITHOUT ever echoing a secret (STDOUT stays protocol-clean; api creds / session
 * strings are never printed).
 *
 * We drive the REAL `runSetup` end-to-end with fail-fast Ink/operator seams. The
 * config itself is a REAL temp file, so the bounded shared config decoder and
 * `formatNonInteractivePlan` path are exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionKeySource } from '../../src/application/index.js';
import { runSetup, type SetupOptions } from '../../src/presentation/cli/setup.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';

const runSetupApp = vi.hoisted((): ReturnType<typeof vi.fn> =>
  vi.fn((): never => {
    throw new Error('non-TTY setup must never load the interactive app');
  }),
);

vi.mock('../../src/presentation/cli/ink/run-setup-app.js', () => ({ runSetupApp }));

const unusedOperator = new Proxy({} as OperatorClientPort, {
  get: (): never => {
    throw new Error('non-TTY setup must never touch the daemon operator');
  },
});

// ---------------------------------------------------------------------------
// Constants — a distinctive api-cred pre-fill so we can prove it never leaks.
// ---------------------------------------------------------------------------

const API_ID = 7654321;
const API_HASH = 'deadbeefdeadbeefdeadbeefdeadbeef';

// ---------------------------------------------------------------------------
// STDIO capture — suppress + record. The plan goes to STDERR; STDOUT is a
// protocol surface and MUST stay empty on this branch.
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

const ORIGINAL_STDIN_TTY = process.stdin.isTTY;
const ORIGINAL_STDERR_TTY = process.stderr.isTTY;
const ORIGINAL_EXIT_CODE = process.exitCode;

// ---------------------------------------------------------------------------
// Temp-config helpers — a REAL file so the genuine read + parse path is used.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

const writeConfigFile = async (contents: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-mcp-nontty-'));
  tempDirs.push(dir);
  const path = join(dir, 'config.json');
  await writeFile(path, contents, 'utf8');
  return path;
};

const optionsFor = (configPath: string): SetupOptions => ({
  configPath,
  sessionDir: join(tmpdir(), `tg-mcp-nontty-sess-${randomUUID()}`),
  // A pre-filled api_hash the process is handed but MUST never print anywhere.
  apiId: API_ID,
  apiHash: API_HASH,
  sessionKey: { kind: 'machine' } satisfies SessionKeySource,
  operatorClient: unusedOperator,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      stdoutChunks.push(chunk);
    }
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      stderrChunks.push(chunk);
    }
    return true;
  });
  // Baseline: a fully interactive terminal. Each test flips a stream to force the
  // non-TTY branch, so the ISATTY decision under test is deterministic regardless
  // of the runner's real streams.
  process.stdin.isTTY = true;
  process.stderr.isTTY = true;
  process.exitCode = undefined;

  runSetupApp.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.stdin.isTTY = ORIGINAL_STDIN_TTY;
  process.stderr.isTTY = ORIGINAL_STDERR_TTY;
  process.exitCode = ORIGINAL_EXIT_CODE;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// 1) The current config summary is printed; the process exits non-zero.
// ---------------------------------------------------------------------------

describe('setup non-TTY branch — plan summary', () => {
  it('prints the current endpoints with their scope summary, then exits non-zero', async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        version: 1,
        endpoints: [
          {
            name: 'support-reader',
            session: 'main',
            tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            scope: {
              chats: ['@releases', 'me'],
              folders: [3],
              // Per-chat override ESCALATES @releases to read+write over the
              // read-only group default — the ACL precedence the tag must reflect.
              chatOverrides: { '@releases': ['read', 'send'] },
            },
            verbs: ['read'],
          },
          {
            name: 'ops-writer',
            session: 'ops',
            tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            scope: { chats: ['@alerts'] },
            verbs: ['read', 'send'],
          },
        ],
      }),
    );
    process.stdin.isTTY = false;

    await runSetup(optionsFor(configPath));

    expect(process.exitCode).toBe(1);

    const err = stderrText();
    // The branch identifies itself and enumerates BOTH endpoints.
    expect(err).toMatch(/non-interactive/i);
    expect(err).toMatch(/TTY/i);
    expect(err).toContain('Current endpoints (2)');

    // support-reader: read-only group, with its scope counts summarised.
    expect(err).toContain('support-reader');
    expect(err).toContain('chats:   2, folders: 1, overrides: 1');

    // ops-writer: the group grants write, so it is flagged WRITABLE.
    expect(err).toContain('ops-writer');
    expect(err).toContain('(WRITABLE)');

    // STDOUT is the protocol surface — nothing is emitted there here.
    expect(stdoutText()).toBe('');
  });

  // -------------------------------------------------------------------------
  // 2) Never blocks: no interactive Console, no prompt, no infra concretes.
  // -------------------------------------------------------------------------

  it('never enters the interactive app or touches the daemon operator', async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        version: 1,
        endpoints: [
          { name: 'reader', session: 'main', scope: { chats: ['@a'] }, verbs: ['read'] },
        ],
      }),
    );
    process.stdin.isTTY = false;

    await runSetup(optionsFor(configPath));

    expect(process.exitCode).toBe(1);
    expect(runSetupApp).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3) First run (no config file yet) — first-run notice, still non-zero.
  // -------------------------------------------------------------------------

  it('on first run (no config file yet) prints the first-run notice and TTY guidance, still exiting non-zero', async () => {
    // A path that does not exist: readFile fails, the plan renders the first-run
    // notice instead of endpoints.
    const missing = join(tmpdir(), `tg-mcp-nontty-missing-${randomUUID()}`, 'config.json');
    process.stdin.isTTY = false;

    await runSetup(optionsFor(missing));

    expect(process.exitCode).toBe(1);
    const err = stderrText();
    expect(err).toMatch(/non-interactive/i);
    expect(err).toMatch(/TTY/i);
    expect(err).toContain('first run');
    expect(err).toContain('secrets never printed');
    // No endpoints => no summary section, and STDOUT stays clean.
    expect(err).not.toContain('Current endpoints');
    expect(stdoutText()).toBe('');
    expect(runSetupApp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4) Secrets are masked — api creds / session material never reach any stream.
// ---------------------------------------------------------------------------

describe('setup non-TTY branch — secret masking', () => {
  it('never prints the api_hash pre-fill or api_id on any stream, and marks the session dir as secret-free', async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        version: 1,
        endpoints: [
          { name: 'reader', session: 'main', scope: { chats: ['me'] }, verbs: ['read'] },
        ],
      }),
    );
    const options = optionsFor(configPath);
    process.stdin.isTTY = false;

    await runSetup(options);

    const all = stderrText() + stdoutText();
    // The api credentials this process was handed are NEVER echoed anywhere: the
    // plan only ever receives the validated config + paths (structural masking).
    expect(all).not.toContain(API_HASH);
    expect(all).not.toContain(String(API_ID));
    // The session directory PATH is shown, explicitly annotated as never printing
    // its (secret) contents; STDOUT carries nothing.
    expect(stderrText()).toContain(options.sessionDir);
    expect(stderrText()).toContain('secrets never printed');
    expect(stdoutText()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5) Both streams must be terminals — a non-TTY STDERR alone forces the branch.
// ---------------------------------------------------------------------------

describe('setup non-TTY branch — ISATTY requires BOTH streams', () => {
  it('takes the non-interactive branch when STDERR is not a TTY even though STDIN is', async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        version: 1,
        endpoints: [
          { name: 'reader', session: 'main', scope: { chats: ['@x'] }, verbs: ['read'] },
        ],
      }),
    );
    // STDIN is a terminal but STDERR (the diagnostics stream) is not — the guard
    // requires BOTH, so this must still refuse to prompt.
    process.stdin.isTTY = true;
    process.stderr.isTTY = false;

    await runSetup(optionsFor(configPath));

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/non-interactive/i);
    expect(runSetupApp).not.toHaveBeenCalled();
  });
});
