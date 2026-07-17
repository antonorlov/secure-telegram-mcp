/**
 * setup — HARDENED interactive unlock (MANDATED FIX #1 regression).
 *
 * The bug: re-running `setup` against an EXISTING HARDENED (PIN) session dropped
 * the operator at the "Logged in — <ref>" main menu based purely on the session
 * FILE existing on disk, WITHOUT ever establishing an unlock channel. The first
 * session-dependent action (Configure endpoints) then failed with
 * "No unlock channel available for this session …" because the construction-time
 * source is `machine` (no env PIN) and a HARDENED envelope carries no machine slot.
 *
 * The current design renders a truthful LOCKED state and authenticates the
 * operator socket with a masked PIN (bounded retry, fail-closed). Setup never
 * opens the encrypted repository itself.
 *
 * These tests drive the REAL `runSetup` with a scripted fake `SetupUi` and
 * operator port. A correct PIN enables Configure, while a wrong/cancelled PIN
 * never exposes a usable session action.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionKeySource } from '../../src/application/index.js';
import { runSetup, type SetupOptions } from '../../src/presentation/cli/setup.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';
import type {
  AccessPickerRequest,
  AccessPickerResult,
} from '../../src/presentation/cli/ink/run-access-picker.js';
import type {
  MenuRequest,
  MenuResult,
} from '../../src/presentation/cli/ink/ui-port.js';
import type {
  ConfirmPromptRequest,
  NoticeRequest,
  PromptResult,
  SetupUi,
} from '../../src/presentation/cli/ink/setup-ui-port.js';
import type {
  AccessBits,
  ChatKey,
} from '../../src/presentation/cli/picker/index.js';

const CORRECT_PIN = 'correct-horse-battery-staple';
const WRONG_PIN = 'not-the-pin-at-all';

const H = vi.hoisted(() => {
  interface Ok<T> {
    readonly ok: true;
    readonly value: T;
  }
  const okv = <T>(value: T): Ok<T> => ({ ok: true, value });

  interface KeySourceLike {
    readonly kind: string;
    readonly passphrase?: string;
  }
  const state: {
    answers: readonly string[];
    cursor: number;
    menuChoices: readonly string[];
    menuCursor: number;
    menuSubtitles: string[];
    verifyCalls: KeySourceLike[];
    statusCalls: number;
    listCalls: number;
    passwordPrompts: number;
    saves: number;
  } = {
    answers: [],
    cursor: 0,
    menuChoices: [],
    menuCursor: 0,
    menuSubtitles: [],
    verifyCalls: [],
    statusCalls: 0,
    listCalls: 0,
    passwordPrompts: 0,
    saves: 0,
  };

  const CANCEL = '__cancel__';
  const nextAnswer = (): string => {
    const answer = state.answers[state.cursor] ?? '';
    state.cursor += 1;
    return answer;
  };
  const nextMenuChoice = (): string => {
    if (state.menuCursor >= state.menuChoices.length) {
      throw new Error(
        `setup opened more menus than were scripted (at index ${String(
          state.menuCursor,
        )})`,
      );
    }
    const choice = state.menuChoices[state.menuCursor] ?? CANCEL;
    state.menuCursor += 1;
    return choice;
  };

  const makeSetupUi = (): SetupUi => ({
    menu: <T,>(request: MenuRequest<T>): Promise<MenuResult<T>> => {
      if (request.subtitle !== undefined) {
        state.menuSubtitles.push(request.subtitle);
      }
      const choice = nextMenuChoice();
      return Promise.resolve(
        choice === CANCEL
          ? { kind: 'cancelled' }
          : { kind: 'selected', value: choice as T },
      );
    },
    text: (): Promise<PromptResult<string>> =>
      Promise.resolve({ kind: 'submitted', value: nextAnswer() }),
    password: (): Promise<PromptResult<string>> => {
      state.passwordPrompts += 1;
      return Promise.resolve({ kind: 'submitted', value: nextAnswer() });
    },
    confirm: (request: ConfirmPromptRequest): Promise<PromptResult<boolean>> => {
      const raw = nextAnswer().trim().toLowerCase();
      const value = raw.length === 0 ? request.defaultValue : raw === 'y' || raw === 'yes';
      return Promise.resolve({ kind: 'submitted', value });
    },
    pickAccess: (request: AccessPickerRequest): Promise<AccessPickerResult> => {
      const selection = new Map<ChatKey, AccessBits>();
      for (const row of request.initialState.rows) {
        if (row.kind === 'chat') {
          selection.set(row.chatKey, { read: true, write: false });
        }
      }
      return Promise.resolve({ committed: true, model: { selection } });
    },
    notify: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
    notice: (request: NoticeRequest): Promise<void> => {
      process.stderr.write(`${[request.title, ...request.body].join('\n')}\n`);
      return Promise.resolve();
    },
    showQr: (): void => undefined,
    status: <T,>(_label: string, task: () => Promise<T>): Promise<T> => task(),
  });

  class FakeFileConfigRepository {
    /** No config on disk yet — these suites edit from a first-run baseline. */
    public loadValidated(): Promise<Ok<undefined>> {
      return Promise.resolve(okv(undefined));
    }
    public save(_config: unknown): Promise<Ok<string>> {
      state.saves += 1;
      return Promise.resolve(okv('{"version":1}\n'));
    }
  }

  return {
    state,
    makeSetupUi,
    FakeFileConfigRepository,
  };
});

vi.mock('../../src/presentation/cli/ink/run-setup-app.js', () => ({
  runSetupApp: (flow: (ui: SetupUi) => Promise<void>): Promise<void> =>
    flow(H.makeSetupUi()),
}));

vi.mock('../../src/infrastructure/config/file-config-repository.js', () => ({
  FileConfigRepository: H.FakeFileConfigRepository,
}));

vi.mock('../../src/infrastructure/endpoint-token.js', () => ({
  mintEndpointToken: (): string => 'tgmcp_test-token',
  hashEndpointToken: (): string => `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`,
  // The env-var-name SSOT the key notices + exit block interpolate.
  ENDPOINT_TOKEN_ENV: 'TELEGRAM_MCP_ENDPOINT_TOKEN',
}));

vi.mock('../../src/infrastructure/app-home.js', () => ({
  defaultConfigPath: (): string => '/nonexistent-default/config.json',
  defaultSessionDir: (): string => '/nonexistent-default/sessions',
}));

vi.mock('../../src/infrastructure/bounded-read.js', () => ({
  readUtf8Bounded: (): Promise<string> => Promise.resolve('{"version":1}'),
}));

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const ORIGINAL_STDIN_TTY = process.stdin.isTTY;
const ORIGINAL_STDERR_TTY = process.stderr.isTTY;
const ORIGINAL_EXIT_CODE = process.exitCode;

const makeOperator = (): OperatorClientPort => ({
  connect: () => Promise.resolve({ ok: true, value: undefined }),
  status: (): ReturnType<OperatorClientPort['status']> => {
    H.state.statusCalls += 1;
    return Promise.resolve({
      ok: true,
      value: {
        posture: 'hardened',
        locked: false,
        hasAccounts: true,
      },
    });
  },
  listAccounts: (): ReturnType<OperatorClientPort['listAccounts']> => {
    H.state.listCalls += 1;
    return Promise.resolve({
      ok: true,
      value: {
        accounts: [{ sessionRef: 'main', label: 'Test User' }],
      },
    });
  },
  authenticate: (source): ReturnType<OperatorClientPort['authenticate']> => {
    H.state.verifyCalls.push(source);
    return source.kind === 'passphrase' && source.passphrase === CORRECT_PIN
      ? Promise.resolve({ ok: true, value: undefined })
      : Promise.resolve({ ok: false, error: 'operator authentication failed' });
  },
  applyPolicy: () =>
    Promise.resolve({ ok: true, value: { digest: 'a'.repeat(64) } }),
  snapshotAccount: () =>
    Promise.resolve({
      ok: true,
      value: {
        chats: [{ id: '-100123', title: 'Team', kind: 'group' }],
        folders: [],
      },
    }),
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

const makeOptions = (): SetupOptions => ({
  configPath: join(tmpdir(), `tg-mcp-${randomUUID()}`, 'config.json'),
  sessionDir: join(tmpdir(), `tg-mcp-${randomUUID()}`),
  // NO env PIN: the construction-time source is `machine`, which cannot open a
  // HARDENED app — exactly the blocked-operator condition.
  sessionKey: { kind: 'machine' } satisfies SessionKeySource,
  operatorClient: makeOperator(),
});

beforeEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') stdoutChunks.push(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') stderrChunks.push(chunk);
    return true;
  });
  process.stdin.isTTY = true;
  process.stderr.isTTY = true;
  process.exitCode = undefined;

  H.state.answers = [];
  H.state.cursor = 0;
  H.state.menuChoices = [];
  H.state.menuCursor = 0;
  H.state.menuSubtitles = [];
  H.state.verifyCalls = [];
  H.state.statusCalls = 0;
  H.state.listCalls = 0;
  H.state.passwordPrompts = 0;
  H.state.saves = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.stdin.isTTY = ORIGINAL_STDIN_TTY;
  process.stderr.isTTY = ORIGINAL_STDERR_TTY;
  process.exitCode = ORIGINAL_EXIT_CODE;
});

describe('setup HARDENED interactive unlock (mandated fix #1)', () => {
  it('renders a LOCKED state (never "Logged in") and PROMPTS for the PIN for a HARDENED session with no env channel', async () => {
    // The operator picks "Enter PIN" but cancels (empty entry): setup must NOT
    // then present any usable session action.
    H.state.menuChoices = ['unlock', 'quit'];
    H.state.answers = ['']; // empty PIN entry -> truthful cancel

    await runSetup(makeOptions());

    // It PROMPTED (did not silently claim a usable session)...
    expect(H.state.passwordPrompts).toBeGreaterThanOrEqual(1);
    // ...the home subtitle was the truthful LOCKED state, never "Logged in"...
    expect(H.state.menuSubtitles.some((s) => s.startsWith('Locked'))).toBe(true);
    expect(H.state.menuSubtitles.some((s) => s.startsWith('Logged in'))).toBe(false);
    // ...and nothing session-dependent ran.
    expect(H.state.saves).toBe(0);
  });

  it('fails closed on a wrong PIN with bounded retry and never opens the session', async () => {
    H.state.menuChoices = ['unlock', 'quit'];
    H.state.answers = [WRONG_PIN, WRONG_PIN, WRONG_PIN];

    await runSetup(makeOptions());

    // Every wrong attempt was verified and rejected (fail-closed); bounded by 3.
    expect(H.state.verifyCalls.length).toBe(3);
    expect(H.state.verifyCalls.every((s) => s.passphrase === WRONG_PIN)).toBe(true);
  });

  it('unlocks with the correct PIN, then opens the session and lets Configure proceed under the verified source', async () => {
    // LOCKED -> Enter PIN (correct) -> unlocked home -> Configure -> add one
    // endpoint -> leave editor -> quit.
    H.state.menuChoices = ['unlock', 'configure', 'add', '__cancel__', 'quit'];
    H.state.answers = [
      CORRECT_PIN, // masked PIN entry (askExistingPin)
      '', // endpoint name -> default 'reader'
      '', // confirm writes? -> default yes
    ];

    await runSetup(makeOptions());

    // The PIN was verified and accepted...
    expect(H.state.verifyCalls.some((s) => s.passphrase === CORRECT_PIN)).toBe(true);
    // ...and configuration was persisted through the operator workflow...
    expect(H.state.saves).toBeGreaterThanOrEqual(1);
    // ...and once unlocked the home menu truthfully said "Logged in".
    expect(H.state.menuSubtitles.some((s) => s.startsWith('Logged in'))).toBe(true);
  });

  it('keeps the verified unlock when Session security is opened and backed out without changing the PIN', async () => {
    H.state.menuChoices = ['unlock', 'security', 'back', 'quit'];
    H.state.answers = [CORRECT_PIN];

    await runSetup(makeOptions());

    const loggedInScreens = H.state.menuSubtitles.filter((s) =>
      s.startsWith('Logged in'),
    );
    const lockedScreens = H.state.menuSubtitles.filter((s) =>
      s.startsWith('Locked'),
    );

    expect(H.state.passwordPrompts).toBe(1);
    expect(loggedInScreens).toHaveLength(2);
    expect(lockedScreens).toHaveLength(1);
    // The security submenu reuses the main menu's account list and makes only
    // its required posture refresh; no duplicate status/accounts requests.
    expect(H.state.statusCalls).toBe(4);
    expect(H.state.listCalls).toBe(2);
  });
});
